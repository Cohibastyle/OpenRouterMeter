# Security

## Credential handling

- The OpenRouter key is stored as a generic-password item in the macOS login
  Keychain, via `security-framework`. This is the direct equivalent of Electron's
  `safeStorage`, so a key saved by the Electron build is readable here and vice
  versa. The service is `openrouter-desktop-widget` and the account is
  `openrouter`.
- There is no ciphertext file. The Keychain owns the encryption and the access
  control, so nothing credential-shaped is written to the app's data directory.
- The plaintext is held in the Rust host's memory only for the duration of a
  request.
- The credential is never written to the SQLite database, a settings file, a log,
  a crash report, or the renderer.
- After saving, the credential is never returned to the renderer, not even masked.
  The UI shows a fixed placeholder and the last four characters of the identifier.
- The credential input is `type="password"` with `autocomplete="off"` and
  `spellcheck="false"`, and its value is cleared as soon as the save completes.
- If the Keychain is unreachable (`errSecInteractionNotAllowed`), the widget
  refuses to persist the key, keeps it in memory for the session only, and
  reports `encryption_unavailable` in the UI.

## Application hardening

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`.
- The renderer loads only local files. `setWindowOpenHandler` denies every new
  window, and `will-navigate` is prevented.
- Content Security Policy:
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'`.
  The renderer has no network access of its own.
- The preload exposes a fixed set of named methods. There is no generic
  `invoke(channel, payload)` passthrough.
- Every IPC handler validates and bounds its arguments. Settings patches reject
  unknown fields and out-of-range values rather than ignoring them.
- `app:openExternal` is allowlisted to OpenRouter URLs only.
- A single instance lock prevents two widgets from running against one database.

## Logging

- Redaction runs at write time in `src/shared/redact.ts`, never at display time.
- Patterns redacted: OpenRouter keys, generic `sk-` keys, authorization headers,
  bearer tokens, `api_key` assignments, and prompt or completion content.
- The in-app view keeps the most recent 2,000 entries in memory. The on-disk log
  rotates at 5 MB with 3 files kept.
- Clearing the in-app view does not delete the on-disk file. Deleting log files is
  a separate confirmed action.

## Data egress

The only outbound traffic is:

1. Requests to `openrouter.ai` for credits, key info, and activity.
2. The update check.

No telemetry, no analytics, and no crash upload without explicit opt-in.

## Clearing data

| Action | Effect |
|---|---|
| Disconnect (Settings → API key) | Removes the credential; local history is kept |
| Clear all local data (Settings → Diagnostics) | Deletes requests, aggregates, keys, logs, and diagnostics; the credential is removed separately |
| Delete the credential file | Requires re-entering the key; history is unaffected |

## Backup and recovery

The credential is not backed up by the widget. If the OS credential store entry is
lost, the user must re-enter the key. Local history is unaffected and remains
readable.

The database is backed up automatically before a destructive migration, to
`widget.db.backup-v<n>`. Settings → Diagnostics can export the full dataset as
JSON.
