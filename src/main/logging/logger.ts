import { app } from 'electron';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { LOG_RING_CAPACITY, LOG_ROTATE_BYTES, LOG_ROTATE_FILES } from '../../shared/constants.js';
import type { LogEntry, LogQuery, LogSource, Severity } from '../../shared/types.js';
import { redact } from '../../shared/redact.js';

export { redact };

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LogInput {
  severity: Severity;
  source: LogSource;
  message: string;
  code?: string | null;
  correlationId?: string | null;
}

export class Logger {
  private readonly ring: LogEntry[] = [];
  private seq = 0;
  private stream: WriteStream | null = null;
  private readonly listeners = new Set<(entry: LogEntry) => void>();
  private readonly dir: string;
  private readonly file: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(app.getPath('userData'), 'logs');
    this.file = join(this.dir, 'widget.log');
    mkdirSync(this.dir, { recursive: true });
    this.openStream();
  }

  get directory(): string {
    return this.dir;
  }

  get filePath(): string {
    return this.file;
  }

  private openStream(): void {
    try {
      this.stream = createWriteStream(this.file, { flags: 'a' });
      this.stream.on('error', () => {
        this.stream = null;
      });
    } catch {
      this.stream = null;
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.file)) return;
      const size = statSync(this.file).size;
      if (size < LOG_ROTATE_BYTES) return;
      this.stream?.end();
      this.stream = null;
      for (let i = LOG_ROTATE_FILES - 1; i >= 1; i -= 1) {
        const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
        const to = `${this.file}.${i}`;
        if (existsSync(from)) {
          if (existsSync(to)) unlinkSync(to);
          renameSync(from, to);
        }
      }
      this.openStream();
    } catch {
      // Rotation failure must never break logging.
    }
  }

  log(input: LogInput): LogEntry {
    const { text, redacted } = redact(input.message);
    const entry: LogEntry = {
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
      severity: input.severity,
      source: input.source,
      code: input.code ?? null,
      message: text,
      correlation_id: input.correlationId ?? null,
      redacted,
    };

    this.ring.push(entry);
    if (this.ring.length > LOG_RING_CAPACITY) this.ring.shift();

    const line = JSON.stringify(entry);
    if (this.stream) {
      this.stream.write(`${line}\n`);
      this.rotateIfNeeded();
    }

    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // A broken listener must not break logging.
      }
    }
    return entry;
  }

  error(source: LogSource, message: string, code?: string, correlationId?: string): LogEntry {
    return this.log({ severity: 'error', source, message, code, correlationId });
  }

  warn(source: LogSource, message: string, code?: string, correlationId?: string): LogEntry {
    return this.log({ severity: 'warn', source, message, code, correlationId });
  }

  info(source: LogSource, message: string, code?: string, correlationId?: string): LogEntry {
    return this.log({ severity: 'info', source, message, code, correlationId });
  }

  debug(source: LogSource, message: string, code?: string, correlationId?: string): LogEntry {
    return this.log({ severity: 'debug', source, message, code, correlationId });
  }

  query(query: LogQuery): LogEntry[] {
    const now = Date.now();
    const rangeMs =
      query.range === '15m'
        ? 15 * 60_000
        : query.range === '1h'
          ? 60 * 60_000
          : query.range === '24h'
            ? 24 * 60 * 60_000
            : Infinity;

    const text = query.text.trim().toLowerCase();
    const severities = new Set(query.severities);
    const sources = new Set(query.sources);

    const out: LogEntry[] = [];
    for (let i = this.ring.length - 1; i >= 0; i -= 1) {
      const entry = this.ring[i]!;
      if (severities.size > 0 && !severities.has(entry.severity)) continue;
      if (sources.size > 0 && !sources.has(entry.source)) continue;
      if (rangeMs !== Infinity && now - new Date(entry.timestamp).getTime() > rangeMs) continue;
      if (text && !entry.message.toLowerCase().includes(text) && !(entry.code ?? '').toLowerCase().includes(text)) {
        continue;
      }
      out.push(entry);
      if (out.length >= query.limit) break;
    }
    return out;
  }

  countErrorsSince(seq: number): number {
    let count = 0;
    for (let i = this.ring.length - 1; i >= 0; i -= 1) {
      const entry = this.ring[i]!;
      if (entry.seq <= seq) break;
      if (entry.severity === 'error') count += 1;
    }
    return count;
  }

  latestSeq(): number {
    return this.seq;
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clearView(): void {
    this.ring.length = 0;
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}

export function severityAtLeast(entry: LogEntry, min: Severity): boolean {
  return SEVERITY_RANK[entry.severity] <= SEVERITY_RANK[min];
}
