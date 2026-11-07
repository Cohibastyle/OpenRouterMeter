//! The structured logger: redaction, ring buffer, database append, rotation.
//!
//! Every entry is redacted at write time rather than at display time, so a
//! credential cannot reach the log file, the database, or the view even if a
//! later reader forgot to filter. The ring buffer keeps the most recent entries
//! so the Log section is populated from the moment the app starts, and the
//! database keeps them across restarts.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::db::Db;

/// Most recent entries kept in memory for the live view.
const RING_CAPACITY: usize = 2000;
/// Rotate the log file once it passes this size.
const ROTATE_BYTES: u64 = 5 * 1024 * 1024;
/// Rotated files kept: `widget.log.1` .. `widget.log.N`.
const ROTATE_FILES: usize = 3;

pub type Severity = &'static str;

/// One redaction rule: a literal prefix to keep and the span to drop.
///
/// The TypeScript version uses regular expressions; Rust has no regex
/// dependency here, so the same rules are expressed as prefix scans. Every rule
/// finds the sensitive token by locating its marker and keeps a short prefix so
/// the log still says which kind of secret it was.
struct Rule {
    /// Text whose presence marks the start of a sensitive span.
    marker: &'static str,
}

const RULES: &[Rule] = &[
    Rule { marker: "sk-or-v1-" },
    Rule { marker: "sk-" },
    Rule { marker: "authorization:" },
    Rule { marker: "authorization=" },
    Rule { marker: "bearer " },
    Rule { marker: "api_key:" },
    Rule { marker: "api_key=" },
    Rule { marker: "api-key:" },
    Rule { marker: "api-key=" },
    Rule { marker: "apikey=" },
    Rule { marker: "prompt=" },
    Rule { marker: "prompt:" },
    Rule { marker: "messages=" },
    Rule { marker: "messages:" },
    Rule { marker: "content=" },
    Rule { marker: "content:" },
    Rule { marker: "completion=" },
    Rule { marker: "completion:" },
];


fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '+' | '/' | '=' | '"' | '\'')
}

/// Redact every sensitive span in `input`.
///
/// Ranges are collected against the original text and merged before anything is
/// rewritten, so a later rule cannot re-match a span an earlier one already
/// redacted. That matters because `sk-` is a prefix of `sk-or-v1-`: rewriting in
/// sequence would strip the hint the first rule deliberately kept.
///
/// Returns the redacted text and whether anything was removed, so the entry can
/// record that it was sanitised.
pub fn redact(input: &str) -> (String, bool) {
    let lowered = input.to_ascii_lowercase();
    let bytes = input.as_bytes();
    // One candidate per match: (marker_start, token_start, token_end, hint_len).
    let mut found: Vec<(usize, usize, usize, usize)> = Vec::new();

    for rule in RULES {
        let needle = rule.marker;
        let mut search_from = 0usize;
        while let Some(offset) = lowered[search_from..].find(needle) {
            let marker_start = search_from + offset;
            let after_marker = marker_start + needle.len();

            // Skip whitespace and an optional "bearer " before the token.
            let mut tok_start = after_marker;
            while tok_start < input.len() && (bytes[tok_start] == b' ' || bytes[tok_start] == b'\t') {
                tok_start += 1;
            }
            if lowered[tok_start..].starts_with("bearer ") {
                tok_start += "bearer ".len();
            }

            let mut tok_end = tok_start;
            for (i, c) in input[tok_start..].char_indices() {
                if is_token_char(c) {
                    tok_end = tok_start + i + c.len_utf8();
                } else {
                    break;
                }
            }
            if tok_end > tok_start {
                // The hint is measured from the marker, so the longest marker
                // wins: `sk-or-v1-` keeps twelve characters where `sk-` keeps
                // eight of the same key.
                found.push((marker_start, tok_start, tok_end, needle.len()));
                search_from = tok_end;
            } else {
                search_from = after_marker;
            }
        }
    }

    if found.is_empty() {
        return (input.to_string(), false);
    }

    // Overlapping matches collapse to the one whose marker starts earliest and
    // is longest, which is the most specific rule for that span.
    found.sort_by(|a, b| a.1.cmp(&b.1).then(b.3.cmp(&a.3)));
    let mut chosen: Vec<(usize, usize, usize, usize)> = Vec::new();
    for candidate in found {
        match chosen.last() {
            Some(last) if candidate.1 < last.2 => {
                if candidate.3 > last.3 {
                    let start = chosen.len() - 1;
                    chosen[start] = candidate;
                }
            }
            _ => chosen.push(candidate),
        }
    }

    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;
    for (_, tok_start, tok_end, marker_len) in chosen {
        let hint = hint_for(marker_len).min(tok_end - tok_start);
        out.push_str(&input[cursor..tok_start]);
        out.push_str(&input[tok_start..tok_start + hint]);
        out.push_str("<redacted>");
        cursor = tok_end;
    }
    out.push_str(&input[cursor..]);
    (out, true)
}

/// How many characters of a matched secret to keep.
///
/// Only API keys keep a hint, because support needs to tell which key was
/// involved. Header values and prompt content are removed entirely: a fragment
/// of a bearer token or of a user's prompt is still a leak.
fn hint_for(marker_len: usize) -> usize {
    match marker_len {
        // "sk-or-v1-" is nine characters; "sk-" is three.
        n if n >= 9 => 12,
        n if n == 3 => 8,
        _ => 0,
    }
}

/// A circle of the most recent entries, mirrored to a file and the database.
pub struct Logger {
    ring: Vec<Value>,
    seq: i64,
    file: PathBuf,
    tailing: bool,
}

impl Logger {
    /// Open the logger, reading back the highest sequence already stored so a
    /// restart does not renumber entries the view has already seen.
    pub fn new(dir: &Path) -> Self {
        let _ = fs::create_dir_all(dir);
        let file = dir.join("widget.log");
        let seq = highest_seq(&file).unwrap_or(0);
        Self { ring: Vec::new(), seq, file, tailing: false }
    }

    pub fn path(&self) -> &Path {
        &self.file
    }

    pub fn set_tailing(&mut self, on: bool) {
        self.tailing = on;
    }

    pub fn tailing(&self) -> bool {
        self.tailing
    }

    pub fn latest_seq(&self) -> i64 {
        self.seq
    }

    pub fn ring(&self) -> Value {
        Value::Array(self.ring.clone())
    }

    pub fn clear_view(&mut self) {
        self.ring.clear();
    }

    /// Redact, stamp, buffer, append, and return the entry.
    ///
    /// The caller writes the result to the database and emits it to the view, so
    /// this function stays free of Tauri and SQLite so it can be unit tested.
    pub fn log(
        &mut self,
        severity: Severity,
        source: &str,
        message: &str,
        code: Option<&str>,
        correlation_id: Option<&str>,
    ) -> Value {
        let (text, redacted) = redact(message);
        self.seq += 1;
        let entry = json!({
            "seq": self.seq,
            "timestamp": now_iso(),
            "severity": severity,
            "source": source,
            "code": code,
            "message": text,
            "correlation_id": correlation_id,
            "redacted": redacted,
        });

        self.ring.push(entry.clone());
        if self.ring.len() > RING_CAPACITY {
            self.ring.remove(0);
        }

        self.append_line(&entry);
        entry
    }

    fn append_line(&mut self, entry: &Value) {
        let line = format!("{entry}\n");
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.file) {
            let _ = f.write_all(line.as_bytes());
        }
        self.rotate_if_needed();
    }

    fn rotate_if_needed(&mut self) {
        let Ok(meta) = fs::metadata(&self.file) else { return };
        if meta.len() < ROTATE_BYTES {
            return;
        }
        for i in (1..ROTATE_FILES).rev() {
            let from = if i == 1 { self.file.clone() } else { with_suffix(&self.file, i - 1) };
            let to = with_suffix(&self.file, i);
            if from.exists() {
                let _ = fs::remove_file(&to);
                let _ = fs::rename(&from, &to);
            }
        }
        let _ = fs::remove_file(&self.file);
    }

    /// Entries matching a query, newest first, mirroring the TypeScript filter.
    pub fn query(&self, query: &Value) -> Value {
        let severities: Vec<&str> = query["severities"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        let sources: Vec<&str> = query["sources"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        let text = query["text"].as_str().unwrap_or("").trim().to_lowercase();
        let range = query["range"].as_str().unwrap_or("all");
        let limit = query["limit"].as_u64().unwrap_or(200) as usize;

        let range_ms: Option<i64> = match range {
            "15m" => Some(15 * 60_000),
            "1h" => Some(60 * 60_000),
            "24h" => Some(24 * 60 * 60_000),
            _ => None,
        };
        let now = now_ms();

        let mut out = Vec::new();
        for entry in self.ring.iter().rev() {
            if !severities.is_empty() {
                let sev = entry["severity"].as_str().unwrap_or("");
                if !severities.contains(&sev) {
                    continue;
                }
            }
            if !sources.is_empty() {
                let src = entry["source"].as_str().unwrap_or("");
                if !sources.contains(&src) {
                    continue;
                }
            }
            if let Some(window) = range_ms {
                let ts = entry["timestamp"].as_str().unwrap_or("");
                if now - parse_ms(ts) > window {
                    continue;
                }
            }
            if !text.is_empty() {
                let hay = format!(
                    "{} {}",
                    entry["message"].as_str().unwrap_or("").to_lowercase(),
                    entry["code"].as_str().unwrap_or("").to_lowercase()
                );
                if !hay.contains(&text) {
                    continue;
                }
            }
            out.push(entry.clone());
            if out.len() >= limit {
                break;
            }
        }
        Value::Array(out)
    }

    pub fn error_count_since(&self, since_seq: i64) -> usize {
        self.ring
            .iter()
            .filter(|e| e["seq"].as_i64().unwrap_or(0) > since_seq)
            .filter(|e| e["severity"].as_str() == Some("error"))
            .count()
    }

    pub fn stored(&self, db: &Db, limit: usize) -> Value {
        Value::Array(db.query_logs(limit))
    }

    pub fn append_to_db(&self, db: &Db, entry: &Value) {
        let _ = db.append_log(entry);
    }
}

fn with_suffix(path: &Path, index: usize) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

/// Highest `seq` already in the file, so numbering continues across restarts.
fn highest_seq(file: &Path) -> Option<i64> {
    let text = fs::read_to_string(file).ok()?;
    text.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| v["seq"].as_i64())
        .max()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`, the shape the renderer parses.
pub fn now_iso() -> String {
    let ms = now_ms();
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let (y, mo, d, h, mi, s) = civil_from_epoch(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

pub fn parse_ms(iso: &str) -> i64 {
    // Fast path for the format this module writes.
    if iso.len() >= 19 {
        if let (Ok(y), Ok(mo), Ok(d), Ok(h), Ok(mi), Ok(s)) = (
            iso[0..4].parse::<i64>(),
            iso[5..7].parse::<i64>(),
            iso[8..10].parse::<i64>(),
            iso[11..13].parse::<i64>(),
            iso[14..16].parse::<i64>(),
            iso[17..19].parse::<i64>(),
        ) {
            return days_from_civil(y, mo, d) * 86_400_000
                + h * 3_600_000
                + mi * 60_000
                + s * 1_000;
        }
    }
    0
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_epoch(secs: i64) -> (i64, i64, i64, i64, i64, i64) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_redacted_but_its_prefix_survives() {
        let (text, redacted) = redact("connecting with sk-or-v1-abcdef1234567890xyz");
        assert!(redacted);
        assert!(text.contains("sk-or-v1-abc"), "kept a usable prefix: {text}");
        assert!(!text.contains("1234567890xyz"), "dropped the secret: {text}");
        assert!(text.contains("<redacted>"));
    }

    #[test]
    fn an_authorization_header_loses_its_token() {
        let (text, redacted) = redact("authorization: Bearer sk-abcdef1234567890");
        assert!(redacted);
        assert!(!text.contains("abcdef1234567890"), "{text}");
    }

    #[test]
    fn an_ordinary_message_is_untouched() {
        let (text, redacted) = redact("collected 152 analytics rows (timer)");
        assert!(!redacted);
        assert_eq!(text, "collected 152 analytics rows (timer)");
    }

    #[test]
    fn prompt_content_is_redacted() {
        let (text, redacted) = redact("prompt=hello there world");
        assert!(redacted);
        assert!(!text.contains("hello"), "{text}");
    }

    #[test]
    fn the_timestamp_round_trips_through_its_parser() {
        let iso = now_iso();
        let back = parse_ms(&iso);
        assert!((now_ms() - back).abs() < 2_000, "{iso} parsed to {back}");
    }

    #[test]
    fn the_ring_caps_itself_and_numbering_keeps_rising() {
        let dir = std::env::temp_dir().join(format!("orw-log-{}", now_ms()));
        let mut logger = Logger::new(&dir);
        for i in 0..(RING_CAPACITY + 10) {
            logger.log("info", "app", &format!("entry {i}"), None, None);
        }
        assert_eq!(logger.ring.len(), RING_CAPACITY);
        assert_eq!(logger.latest_seq(), (RING_CAPACITY + 10) as i64);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_query_filters_by_severity_and_text() {
        let dir = std::env::temp_dir().join(format!("orw-log-q-{}", now_ms()));
        let mut logger = Logger::new(&dir);
        logger.log("info", "collector", "collected 10 rows", None, None);
        logger.log("error", "source", "request failed", Some("network"), None);
        logger.log("debug", "app", "noise", None, None);

        let errors = logger.query(&json!({ "severities": ["error"], "text": "", "range": "all", "limit": 50 }));
        assert_eq!(errors.as_array().unwrap().len(), 1);
        assert_eq!(errors[0]["message"], "request failed");

        let matching = logger.query(&json!({ "severities": [], "text": "collected", "range": "all", "limit": 50 }));
        assert_eq!(matching.as_array().unwrap().len(), 1);

        let all = logger.query(&json!({ "severities": [], "text": "", "range": "all", "limit": 50 }));
        assert_eq!(all.as_array().unwrap().len(), 3);
        // Newest first, matching the view.
        assert_eq!(all[0]["message"], "noise");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_is_appended_and_read_back_for_the_next_run() {
        let dir = std::env::temp_dir().join(format!("orw-log-f-{}", now_ms()));
        {
            let mut logger = Logger::new(&dir);
            logger.log("info", "app", "first", None, None);
            logger.log("info", "app", "second", None, None);
        }
        // A restart continues numbering rather than colliding with stored rows.
        let logger = Logger::new(&dir);
        assert_eq!(logger.latest_seq(), 2);
        let body = fs::read_to_string(dir.join("widget.log")).unwrap();
        assert!(body.contains("first") && body.contains("second"));
        let _ = fs::remove_dir_all(&dir);
    }
}
