import { app } from 'electron';
import { cpus, arch, platform, release, totalmem, freemem } from 'node:os';
import { SCHEMA_VERSION } from '../../shared/constants.js';
import type { DiagnosticBundle } from '../../shared/types.js';

export interface DiagnosticsInputs {
  connection: Record<string, unknown>;
  source: Record<string, unknown>;
  coverage: Record<string, unknown>;
  collection: Record<string, unknown>;
  storage: Record<string, unknown>;
  window: Record<string, unknown>;
  lastResizeFrameMs: number;
}

export function environmentInfo(): Record<string, unknown> {
  const sessionType = process.env.XDG_SESSION_TYPE ?? (platform() === 'darwin' ? 'aqua' : 'unknown');
  return {
    os: `${platform()} ${release()}`,
    arch: arch(),
    session_type: sessionType,
    locale: app.getLocale(),
    cpu_model: cpus()[0]?.model ?? 'unknown',
    cpu_count: cpus().length,
    total_memory_mb: Math.round(totalmem() / 1024 / 1024),
    free_memory_mb: Math.round(freemem() / 1024 / 1024),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
  };
}

export function performanceInfo(lastResizeFrameMs: number): Record<string, unknown> {
  const memory = process.memoryUsage();
  return {
    main_rss_mb: Math.round(memory.rss / 1024 / 1024),
    main_heap_mb: Math.round(memory.heapUsed / 1024 / 1024),
    last_resize_frame_ms: Number(lastResizeFrameMs.toFixed(2)),
    uptime_sec: Math.round(process.uptime()),
  };
}

export function buildDiagnosticBundle(inputs: DiagnosticsInputs, trigger: string): DiagnosticBundle {
  return {
    captured_at: new Date().toISOString(),
    trigger,
    schema_version: SCHEMA_VERSION,
    connection: inputs.connection,
    source: inputs.source,
    coverage: inputs.coverage,
    collection: inputs.collection,
    storage: inputs.storage,
    performance: performanceInfo(inputs.lastResizeFrameMs),
    window: inputs.window,
    environment: environmentInfo(),
  };
}

/**
 * Redact a bundle before it leaves the app. The bundle never contains the
 * credential or request content, but this is a second line of defence.
 */
export function redactBundle(bundle: DiagnosticBundle): DiagnosticBundle {
  const json = JSON.stringify(bundle);
  const cleaned = json
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]+/g, '<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '<redacted>')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<redacted>');
  return JSON.parse(cleaned) as DiagnosticBundle;
}

export function bundleToText(bundle: DiagnosticBundle): string {
  return JSON.stringify(bundle, null, 2);
}
