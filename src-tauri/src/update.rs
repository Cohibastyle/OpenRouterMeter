//! Update check against the published GitHub releases.
//!
//! This is a read-only check: it asks GitHub for the newest tag, compares it
//! with the running version, and reports the result. It never downloads or
//! installs anything, so a failed or blocked request is harmless and simply
//! reports `failed` rather than pretending to be up to date.

use serde_json::{json, Value};

/// Where the releases are published.
const RELEASES_URL: &str = "https://api.github.com/repos/Cohibastyle/OpenRouterMeter/releases/latest";

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent(concat!("OpenRouterMeter/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// Compare two dotted versions, ignoring a leading `v`.
///
/// Returns true when `candidate` is newer than `current`. Numeric comparison
/// per component, so `0.10.0` beats `0.9.0`, which string ordering gets wrong.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim()
            .trim_start_matches('v')
            .split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect()
    };
    let a = parse(candidate);
    let b = parse(current);
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// Ask GitHub for the latest release and classify the result.
pub fn check() -> Value {
    let current = env!("CARGO_PKG_VERSION");
    let checked_at = crate::logging::now_iso();

    let client = match client() {
        Ok(c) => c,
        Err(e) => {
            return json!({
                "state": "failed", "checked_at": checked_at,
                "current": current, "latest": Value::Null, "error": e,
                "release_notes_url": RELEASES_URL,
            })
        }
    };

    let response = match client.get(RELEASES_URL).send() {
        Ok(r) => r,
        Err(e) => {
            return json!({
                "state": "failed", "checked_at": checked_at,
                "current": current, "latest": Value::Null, "error": e.to_string(),
                "release_notes_url": RELEASES_URL,
            })
        }
    };

    // A repository with no published release answers 404, which is not a
    // failure of the check: it means there is nothing to upgrade to.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return json!({
            "state": "up_to_date", "checked_at": checked_at,
            "current": current, "latest": Value::Null, "error": Value::Null,
            "release_notes_url": RELEASES_URL,
        });
    }

    if !response.status().is_success() {
        return json!({
            "state": "failed", "checked_at": checked_at,
            "current": current, "latest": Value::Null,
            "error": format!("http {}", response.status().as_u16()),
            "release_notes_url": RELEASES_URL,
        });
    }

    let body: Value = match response.json() {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "state": "failed", "checked_at": checked_at,
                "current": current, "latest": Value::Null, "error": e.to_string(),
                "release_notes_url": RELEASES_URL,
            })
        }
    };

    let tag = body["tag_name"].as_str().unwrap_or("").to_string();
    let newer = !tag.is_empty() && is_newer(&tag, current);
    json!({
        "state": if newer { "available" } else { "up_to_date" },
        "checked_at": checked_at,
        "current": current,
        "latest": if tag.is_empty() { Value::Null } else { json!(tag) },
        "error": Value::Null,
        "release_notes_url": body["html_url"].as_str().unwrap_or(RELEASES_URL),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_higher_tag_is_newer() {
        assert!(is_newer("v0.3.0", "0.2.0"));
        assert!(is_newer("0.2.1", "0.2.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
    }

    #[test]
    fn numeric_components_compare_as_numbers_not_strings() {
        // String ordering would call 0.9 newer than 0.10; it is not.
        assert!(is_newer("0.10.0", "0.9.0"));
        assert!(!is_newer("0.9.0", "0.10.0"));
    }

    #[test]
    fn the_same_or_older_tag_is_not_newer() {
        assert!(!is_newer("v0.2.0", "0.2.0"));
        assert!(!is_newer("0.1.9", "0.2.0"));
    }

    #[test]
    fn a_suffix_does_not_confuse_the_comparison() {
        assert!(is_newer("v0.3.0-beta.1", "0.2.0"));
        assert!(!is_newer("v0.2.0-beta", "0.2.0"));
    }
}
