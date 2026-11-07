//! OpenRouter collector, ported from src/main/collectors/openrouter.ts.
//!
//! Only endpoints verified to exist are used. Anything that cannot be confirmed
//! is reported as a capability gap rather than invented, per FSD section 4.2.
//!
//! The analytics endpoint is the primary source: it is what the OpenRouter
//! dashboard itself uses, it reports the current day, and it supports sub-daily
//! granularity. `/activity` is kept as a fallback because it returns a fixed set
//! of daily rows that can stop several days behind today.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::accounting::{format_time, parse_time, MICRO};

pub const CREDITS_URL: &str = "https://openrouter.ai/api/v1/credits";
pub const KEY_URL: &str = "https://openrouter.ai/api/v1/key";
pub const ACTIVITY_URL: &str = "https://openrouter.ai/api/v1/activity";
pub const ANALYTICS_QUERY_URL: &str = "https://openrouter.ai/api/v1/analytics/query";
pub const ANALYTICS_META_URL: &str = "https://openrouter.ai/api/v1/analytics/meta";
pub const KEYS_URL: &str = "https://openrouter.ai/api/v1/keys";

const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CollectorErrorCode {
    InvalidCredential,
    RateLimit,
    SourceOutage,
    NetworkOffline,
    Unknown,
}

impl CollectorErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::InvalidCredential => "invalid_credential",
            Self::RateLimit => "rate_limit",
            Self::SourceOutage => "source_outage",
            Self::NetworkOffline => "network_offline",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CollectorError {
    pub code: CollectorErrorCode,
    pub message: String,
    pub status: Option<u16>,
    pub retry_after_ms: Option<i64>,
}

impl CollectorError {
    fn new(code: CollectorErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), status: None, retry_after_ms: None }
    }

    fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

fn request_json(
    url: &str,
    api_key: &str,
    body: Option<&Value>,
) -> Result<Value, CollectorError> {
    let client = client();
    let mut req = client
        .get(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .header("HTTP-Referer", "https://github.com/openrouter-desktop-widget")
        .header("X-Title", "OpenRouter Desktop Widget");

    if let Some(payload) = body {
        req = client
            .post(url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("HTTP-Referer", "https://github.com/openrouter-desktop-widget")
            .header("X-Title", "OpenRouter Desktop Widget")
            .json(payload);
    }

    let response = req.send().map_err(|e| {
        if e.is_timeout() {
            CollectorError::new(CollectorErrorCode::SourceOutage, "Request timed out")
        } else {
            CollectorError::new(CollectorErrorCode::NetworkOffline, format!("Network unreachable: {e}"))
        }
    })?;

    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(CollectorError::new(
            CollectorErrorCode::InvalidCredential,
            "The credential was rejected by OpenRouter",
        )
        .with_status(status.as_u16()));
    }
    if status.as_u16() == 429 {
        let retry = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|v| *v > 0)
            .map(|v| v * 1000)
            .unwrap_or(60_000);
        let mut err = CollectorError::new(CollectorErrorCode::RateLimit, "OpenRouter rate limit reached")
            .with_status(429);
        err.retry_after_ms = Some(retry);
        return Err(err);
    }
    if status.as_u16() >= 500 {
        return Err(CollectorError::new(
            CollectorErrorCode::SourceOutage,
            format!("OpenRouter returned {}", status.as_u16()),
        )
        .with_status(status.as_u16()));
    }
    if !status.is_success() {
        return Err(CollectorError::new(
            CollectorErrorCode::Unknown,
            format!("OpenRouter returned {}", status.as_u16()),
        )
        .with_status(status.as_u16()));
    }

    response.json::<Value>().map_err(|_| {
        CollectorError::new(
            CollectorErrorCode::SourceOutage,
            "OpenRouter returned a non-JSON response",
        )
    })
}

fn num(value: &Value) -> Option<f64> {
    if let Some(n) = value.as_f64() {
        return Some(n);
    }
    value.as_str().and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            t.parse::<f64>().ok()
        }
    })
}

fn micro_from_number(value: f64) -> i64 {
    (value * MICRO as f64).round() as i64
}

fn micro_of(value: &Value) -> Option<i64> {
    num(value).map(micro_from_number)
}

/// OpenRouter returns activity dates as `YYYY-MM-DD HH:mm:ss` with no zone.
/// Reading that as local time would shift the day boundary and misattribute
/// spend, so it is treated as UTC, which is what the source means.
pub fn parse_source_date(value: Option<&str>) -> String {
    let Some(raw) = value else {
        return format_time(now_ms());
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return format_time(now_ms());
    }

    // Already ISO with an explicit zone.
    if trimmed.ends_with('Z') || trimmed.ends_with('z') {
        if let Some(ms) = parse_time(trimmed) {
            return format_time(ms);
        }
    }

    // `YYYY-MM-DD HH:mm:ss` or `YYYY-MM-DD`, read as UTC.
    let normalized = trimmed.replace(' ', "T");
    let with_seconds = if normalized.len() == 16 {
        format!("{normalized}:00Z")
    } else if normalized.len() == 10 {
        format!("{normalized}T00:00:00Z")
    } else {
        format!("{normalized}Z")
    };
    parse_time(&with_seconds)
        .map(format_time)
        .unwrap_or_else(|| format_time(now_ms()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct Collector {
    api_key: String,
}

impl Collector {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self { api_key: api_key.into() }
    }

    pub fn fetch_credits(&self) -> Result<(Option<i64>, Option<i64>), CollectorError> {
        let json = request_json(CREDITS_URL, &self.api_key, None)?;
        let data = &json["data"];
        Ok((micro_of(&data["total_credits"]), micro_of(&data["total_usage"])))
    }

    pub fn fetch_key_info(&self) -> Result<Value, CollectorError> {
        let json = request_json(KEY_URL, &self.api_key, None)?;
        let data = &json["data"];

        let raw_label = data["label"].as_str().or_else(|| data["name"].as_str());
        // A label must never be the credential itself. If the source echoes
        // something key-shaped, discard it rather than persist a secret.
        let label = raw_label.filter(|l| !looks_like_credential(l));

        Ok(json!({
            "label": label,
            "last4": if self.api_key.len() >= 8 {
                Some(self.api_key[self.api_key.len() - 4..].to_string())
            } else {
                None
            },
            "limit_micro": micro_of(&data["limit"]),
            "usage_micro": micro_of(&data["usage"]),
            "usage_daily_micro": micro_of(&data["usage_daily"]),
            "usage_weekly_micro": micro_of(&data["usage_weekly"]),
            "usage_monthly_micro": micro_of(&data["usage_monthly"]),
            "is_free_tier": data["is_free_tier"].as_bool(),
            "is_management_key": data["is_management_key"].as_bool().unwrap_or(false),
        }))
    }

    /// Activity rows. The endpoint returns per-day, per-model aggregates, so the
    /// finest granularity is one day and the short windows are honestly
    /// unavailable with reason `source_granularity`.
    pub fn fetch_activity(&self) -> Result<Vec<Value>, CollectorError> {
        let json = request_json(ACTIVITY_URL, &self.api_key, None)?;
        let rows = json["data"].as_array().cloned().unwrap_or_default();

        Ok(rows
            .iter()
            .map(|r| {
                let input = num(&r["prompt_tokens"]).or_else(|| num(&r["input_tokens"]));
                let output = num(&r["completion_tokens"]).or_else(|| num(&r["output_tokens"]));
                let total = num(&r["total_tokens"]).or_else(|| match (input, output) {
                    (None, None) => None,
                    (i, o) => Some(i.unwrap_or(0.0) + o.unwrap_or(0.0)),
                });
                json!({
                    "date": parse_source_date(
                        r["date"].as_str().or_else(|| r["created_at"].as_str())
                    ),
                    "model": r["model"].as_str().or_else(|| r["model_permaslug"].as_str()),
                    "endpoint_id": r["endpoint_id"].as_str(),
                    "provider_name": r["provider_name"].as_str(),
                    // The activity endpoint does not report key identity.
                    // Leaving these null is honest; guessing would be wrong.
                    "key_id": r["key_id"].as_str().or_else(|| r["api_key_id"].as_str()),
                    "key_name": r["key_name"].as_str().or_else(|| r["label"].as_str()),
                    "requests": num(&r["requests"]).or_else(|| num(&r["request_count"])),
                    "input_tokens": input,
                    "output_tokens": output,
                    "total_tokens": total,
                    "cost_micro": micro_of(&r["usage"]).or_else(|| micro_of(&r["cost"])),
                })
            })
            .collect())
    }

    /// Query the analytics endpoint, which is what the OpenRouter dashboard uses.
    pub fn query_analytics(
        &self,
        metrics: &[&str],
        dimensions: &[&str],
        granularity: &str,
        start: &str,
        end: &str,
        limit: Option<u32>,
    ) -> Result<Value, CollectorError> {
        let mut body = Map::new();
        body.insert("metrics".into(), json!(metrics));
        body.insert("granularity".into(), json!(granularity));
        body.insert("time_range".into(), json!({ "start": start, "end": end }));
        if !dimensions.is_empty() {
            body.insert("dimensions".into(), json!(dimensions));
        }
        if let Some(l) = limit {
            body.insert("limit".into(), json!(l));
        }

        let json = request_json(ANALYTICS_QUERY_URL, &self.api_key, Some(&Value::Object(body)))?;
        Ok(parse_analytics_response(&json, granularity, dimensions))
    }

    pub fn fetch_keys(&self) -> Result<Vec<Value>, CollectorError> {
        let json = request_json(KEYS_URL, &self.api_key, None)?;
        let rows = json["data"].as_array().cloned().unwrap_or_default();
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let hash = row["hash"].as_str()?.to_string();
                if hash.is_empty() {
                    return None;
                }
                Some(json!({
                    "hash": hash,
                    "name": row["name"].as_str().unwrap_or(""),
                    "label": row["label"].as_str(),
                }))
            })
            .collect())
    }

    /// Probe which endpoints answer. An invalid credential aborts the probe,
    /// because every other result would be meaningless.
    pub fn probe_capabilities(&self) -> Result<Value, CollectorError> {
        let mut caps = json!({
            "credits": false,
            "key_info": false,
            "activity": false,
            "analytics": false,
            "keys": false,
            "request_feed": false,
            "granularity_ms": 24 * 60 * 60 * 1000,
            "reporting_delay_sec": 60,
        });

        let mut attempt = |f: &dyn Fn() -> Result<(), CollectorError>| -> Result<bool, CollectorError> {
            match f() {
                Ok(()) => Ok(true),
                Err(e) if e.code == CollectorErrorCode::InvalidCredential => Err(e),
                Err(_) => Ok(false),
            }
        };

        caps["credits"] = json!(attempt(&|| self.fetch_credits().map(|_| ()))?);
        caps["key_info"] = json!(attempt(&|| self.fetch_key_info().map(|_| ()))?);
        caps["activity"] = json!(attempt(&|| self.fetch_activity().map(|_| ()))?);

        // The analytics endpoint is the live source. When it answers, the
        // granularity floor drops from a day to a minute.
        let now = now_ms();
        let analytics = attempt(&|| {
            self.query_analytics(
                &["total_usage"],
                &[],
                "hour",
                &format_time(now - 2 * 3_600_000),
                &format_time(now),
                Some(5),
            )
            .map(|_| ())
        })?;
        caps["analytics"] = json!(analytics);
        if analytics {
            caps["request_feed"] = json!(true);
            caps["granularity_ms"] = json!(60_000);
            caps["reporting_delay_sec"] = json!(120);
        }

        caps["keys"] = json!(attempt(&|| self.fetch_keys().map(|_| ()))?);
        Ok(caps)
    }
}

/// Parse a full analytics response envelope.
pub fn parse_analytics_response(payload: &Value, granularity: &str, dimensions: &[&str]) -> Value {
    let raw_rows = payload["data"]["data"].as_array().cloned().unwrap_or_default();
    let date_key = format!("date__{granularity}");

    let mut rows = Vec::new();
    for raw in &raw_rows {
        let Some(raw_date) = raw[&date_key].as_str() else { continue };
        let bucket = parse_source_date(Some(raw_date));

        let mut dims = Map::new();
        for name in dimensions {
            if let Some(v) = raw.get(*name) {
                if !v.is_null() {
                    dims.insert((*name).to_string(), json!(v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())));
                }
            }
        }

        rows.push(json!({
            "bucket": bucket,
            "total_usage_micro": num(&raw["total_usage"]),
            "tokens_total": num(&raw["tokens_total"]),
            "tokens_prompt": num(&raw["tokens_prompt"]),
            "tokens_completion": num(&raw["tokens_completion"]),
            "request_count": num(&raw["request_count"]),
            "cached_tokens": num(&raw["cached_tokens"]),
            "reasoning_tokens": num(&raw["reasoning_tokens"]),
            "dimensions": Value::Object(dims),
        }));
    }

    json!({
        "rows": rows,
        "truncated": payload["data"]["metadata"]["truncated"].as_bool().unwrap_or(false),
        "granularity": granularity,
    })
}

/// Map analytics rows to request records.
///
/// The natural key is the bucket plus every dimension value, so re-running the
/// same query updates rows in place instead of duplicating them.
pub fn analytics_to_requests(rows: &[Value], granularity: &str, key_names: &BTreeMap<String, String>) -> Vec<Value> {
    let now = format_time(now_ms());
    rows.iter()
        .map(|row| {
            let dims_obj = row["dimensions"].as_object().cloned().unwrap_or_default();
            let raw_key = dims_obj.get("api_key_id").and_then(|v| v.as_str());
            // The api_key_id dimension comes back enriched as the key's display
            // name, not the hash. Map it back so the row shares an identifier
            // with the api_key table.
            let key_hash = raw_key.map(|k| key_names.get(k).cloned().unwrap_or_else(|| k.to_string()));

            let mut names: Vec<&String> = dims_obj.keys().collect();
            names.sort();
            let dims = names
                .iter()
                .map(|n| format!("{n}={}", dims_obj.get(*n).and_then(|v| v.as_str()).unwrap_or("")))
                .collect::<Vec<_>>()
                .join("|");

            let bucket = row["bucket"].as_str().unwrap_or("");

            json!({
                "id": format!("analytics:{granularity}:{bucket}:{dims}"),
                "event_time": bucket,
                "received_time": now,
                "key_id": key_hash,
                "key_name": raw_key,
                "model": dims_obj.get("model").and_then(|v| v.as_str()),
                "status": "aggregate",
                "input_tokens": row["tokens_prompt"].as_i64(),
                "output_tokens": row["tokens_completion"].as_i64(),
                "total_tokens": row["tokens_total"].as_i64(),
                // total_usage is in dollars, not micro-dollars.
                "cost_micro": row["total_usage_micro"].as_f64().map(micro_from_number),
                "source": format!("openrouter.analytics.{granularity}"),
            })
        })
        .collect()
}

/// Convert activity rows into normalized request records for local storage.
pub fn activity_to_requests(rows: &[Value]) -> Vec<Value> {
    let now = format_time(now_ms());
    rows.iter()
        .map(|row| {
            let date = row["date"].as_str().unwrap_or("");
            let model = row["model"].as_str().unwrap_or("unknown");
            let endpoint = row["endpoint_id"].as_str().unwrap_or("default");
            let provider = row["provider_name"].as_str().unwrap_or("unknown");
            json!({
                // The natural key is date, model, endpoint, and provider. A
                // positional index would change whenever the source reorders
                // rows, which created a duplicate record on every fetch.
                "id": format!("activity:{date}:{model}:{endpoint}:{provider}"),
                "event_time": date,
                "received_time": now,
                "key_id": row["key_id"],
                "key_name": row["key_name"],
                "model": row["model"],
                "status": "aggregate",
                "input_tokens": row["input_tokens"],
                "output_tokens": row["output_tokens"],
                "total_tokens": row["total_tokens"],
                "cost_micro": row["cost_micro"],
                "source": "openrouter.activity",
            })
        })
        .collect()
}

/// True when a string looks like a credential rather than a label.
fn looks_like_credential(value: &str) -> bool {
    let v = value.trim();
    if v.len() < 20 {
        return false;
    }
    v.starts_with("sk-or-") || v.starts_with("sk-") || (v.len() >= 40 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_dates_are_read_as_utc() {
        // "2026-11-06 12:00:00" must not shift with the local zone.
        assert_eq!(parse_source_date(Some("2026-11-06 12:00:00")), "2026-11-06T12:00:00.000Z");
        assert_eq!(parse_source_date(Some("2026-11-06")), "2026-11-06T00:00:00.000Z");
        assert_eq!(parse_source_date(Some("2026-11-06T12:00:00Z")), "2026-11-06T12:00:00.000Z");
    }

    #[test]
    fn a_credential_is_never_used_as_a_label() {
        assert!(looks_like_credential("sk-or-v1-0123456789abcdef0123456789abcdef"));
        assert!(!looks_like_credential("prod-key"));
    }

    #[test]
    fn analytics_rows_keep_one_granularity_in_the_source() {
        let payload = json!({
            "data": {
                "data": [
                    { "date__hour": "2026-11-06 12:00:00", "total_usage": 0.5, "tokens_total": 100 },
                ],
                "metadata": { "truncated": false }
            }
        });
        let parsed = parse_analytics_response(&payload, "hour", &[]);
        let rows = parsed["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["bucket"], "2026-11-06T12:00:00.000Z");

        let requests = analytics_to_requests(rows, "hour", &BTreeMap::new());
        assert_eq!(requests[0]["source"], "openrouter.analytics.hour");
        assert_eq!(requests[0]["cost_micro"], 500_000);
    }

    #[test]
    fn activity_rows_are_keyed_by_content_not_position() {
        let rows = vec![json!({
            "date": "2026-11-06T00:00:00.000Z",
            "model": "openai/gpt-5.1",
            "endpoint_id": null,
            "provider_name": null,
            "cost_micro": 1000,
        })];
        let a = activity_to_requests(&rows);
        let b = activity_to_requests(&rows);
        assert_eq!(a[0]["id"], b[0]["id"], "the same row must produce the same id");
    }
}
