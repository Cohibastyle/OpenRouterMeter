//! Credential storage, ported from src/main/credentials.ts.
//!
//! Electron's `safeStorage` maps to the macOS Keychain. The direct equivalent is
//! a generic-password item in the login keychain, which is what this uses, so a
//! key saved by the Electron build is readable here and vice versa.
//!
//! The plaintext never touches disk, the database, a log, or the renderer. If
//! the keychain is unavailable the secret is held in memory for the session and
//! the caller is told it was not persisted.

use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};

const SERVICE: &str = "openrouter-desktop-widget";
const ACCOUNT: &str = "openrouter";

pub struct CredentialStore {
    memory_only: Option<String>,
}

impl CredentialStore {
    pub fn new() -> Self {
        Self { memory_only: None }
    }

    /// True when the OS keychain can be used at all.
    pub fn is_encryption_available(&self) -> bool {
        // A read of a missing item returns an error, which still proves the
        // keychain is reachable. Only a hard failure means unavailable.
        match get_generic_password(SERVICE, ACCOUNT) {
            Ok(_) => true,
            Err(e) => e.code() != -25308, // errSecInteractionNotAllowed
        }
    }

    /// Store the credential. Returns false when it could only be kept in memory.
    pub fn save(&mut self, secret: &str) -> bool {
        if !self.is_encryption_available() {
            self.memory_only = Some(secret.to_string());
            return false;
        }
        match set_generic_password(SERVICE, ACCOUNT, secret.as_bytes()) {
            Ok(()) => {
                self.memory_only = None;
                true
            }
            Err(_) => {
                self.memory_only = Some(secret.to_string());
                false
            }
        }
    }

    /// Read the credential for a single request. Never exposed over the bridge.
    pub fn read(&self) -> Option<String> {
        if let Some(secret) = &self.memory_only {
            return Some(secret.clone());
        }
        get_generic_password(SERVICE, ACCOUNT)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    }

    pub fn has(&self) -> bool {
        self.memory_only.is_some() || self.read().is_some()
    }

    /// True when a credential is stored *and* readable. A keychain entry that
    /// cannot be decrypted still reports present, which would leave the UI
    /// claiming a live connection while every request fell back to sample data.
    pub fn is_usable(&self) -> bool {
        self.read().is_some()
    }

    pub fn clear(&mut self) {
        self.memory_only = None;
        let _ = delete_generic_password(SERVICE, ACCOUNT);
    }

    /// Last four characters of the identifier, for display only.
    pub fn last4(secret: Option<&str>) -> Option<String> {
        let secret = secret?;
        if secret.len() < 8 {
            return None;
        }
        Some(secret[secret.len() - 4..].to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last4_needs_a_long_enough_secret() {
        assert_eq!(CredentialStore::last4(Some("sk-or-v1-abcdefa91f")), Some("a91f".into()));
        assert_eq!(CredentialStore::last4(Some("short")), None);
        assert_eq!(CredentialStore::last4(None), None);
    }
}
