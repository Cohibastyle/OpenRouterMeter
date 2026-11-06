import { safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Credential storage per FSD section 11.1.
 *
 * The key is encrypted with Electron safeStorage, which maps to the macOS
 * Keychain, Windows DPAPI, and libsecret/KWallet on Linux. The ciphertext lives
 * in a file inside the app's userData directory; the plaintext never touches
 * disk, the database, a log, or the renderer.
 *
 * If safeStorage reports encryption is unavailable, we refuse to persist and
 * report `encryption_unavailable` so the UI can explain the limitation.
 */
export class CredentialStore {
  private readonly file: string;
  private memoryOnly: string | null = null;

  constructor(userDataDir: string) {
    const dir = join(userDataDir, 'credentials');
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'openrouter.bin');
  }

  isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /** Store the credential. Returns false when encryption is unavailable. */
  save(secret: string): boolean {
    if (!this.isEncryptionAvailable()) {
      // Refuse to persist. Keep it in memory for this session only.
      this.memoryOnly = secret;
      return false;
    }
    const encrypted = safeStorage.encryptString(secret);
    writeFileSync(this.file, encrypted, { mode: 0o600 });
    this.memoryOnly = null;
    return true;
  }

  /** Read the credential for a single request. Never exposed over IPC. */
  read(): string | null {
    if (this.memoryOnly) return this.memoryOnly;
    if (!existsSync(this.file)) return null;
    if (!this.isEncryptionAvailable()) return null;
    try {
      const encrypted = readFileSync(this.file);
      return safeStorage.decryptString(encrypted);
    } catch {
      return null;
    }
  }

  has(): boolean {
    return this.memoryOnly !== null || existsSync(this.file);
  }

  /**
   * True when a credential is stored *and* readable.
   *
   * `has()` only proves a file exists. A file that cannot be decrypted, for
   * example because the keychain entry is missing or was reset, still reports
   * present. Trusting that leaves the UI claiming a live connection while every
   * request silently falls back to sample data or stale rows.
   */
  isUsable(): boolean {
    return this.read() !== null;
  }

  clear(): void {
    this.memoryOnly = null;
    try {
      if (existsSync(this.file)) unlinkSync(this.file);
    } catch {
      // Nothing to clear.
    }
  }

  /** Last four characters of the identifier, for display only. */
  static last4(secret: string | null): string | null {
    if (!secret || secret.length < 8) return null;
    return secret.slice(-4);
  }
}
