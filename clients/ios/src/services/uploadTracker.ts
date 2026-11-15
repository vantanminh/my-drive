import { MyDriveApiError } from './apiClient';
import { formatBytes } from './format';

/**
 * Rolling time-window + EWMA throughput tracker for mobile uploads.
 * Smooths chunk-commit pauses so displayed speed does not snap to 0 MB/s
 * during normal NAS disk flushes, while decaying gently if stalled > 1.2s.
 */
export class UploadThroughputTracker {
  private samples: Array<{ timeMs: number; bytes: number }> = [];
  private smoothedBps = 0;
  private lastProgressAtMs: number;

  constructor(initialBytes = 0, nowMs = Date.now()) {
    this.samples.push({ timeMs: nowMs, bytes: Math.max(0, initialBytes) });
    this.lastProgressAtMs = nowMs;
  }

  reset(bytes = 0, nowMs = Date.now()): void {
    this.samples = [{ timeMs: nowMs, bytes: Math.max(0, bytes) }];
    this.smoothedBps = 0;
    this.lastProgressAtMs = nowMs;
  }

  record(bytes: number, nowMs = Date.now()): number {
    const cleanBytes = Math.max(0, bytes);
    const prev = this.samples[this.samples.length - 1];
    if (prev && cleanBytes > prev.bytes) {
      this.lastProgressAtMs = nowMs;
    }
    this.samples.push({ timeMs: nowMs, bytes: cleanBytes });

    const cutoff = nowMs - 3500;
    while (this.samples.length > 2 && this.samples[0].timeMs < cutoff) {
      this.samples.shift();
    }

    const first = this.samples[0];
    const latest = this.samples[this.samples.length - 1];
    const elapsedSec = (latest.timeMs - first.timeMs) / 1000;
    const deltaBytes = latest.bytes - first.bytes;

    if (deltaBytes > 0 && elapsedSec >= 0.08) {
      const windowBps = deltaBytes / elapsedSec;
      this.smoothedBps =
        this.smoothedBps > 0 ? this.smoothedBps * 0.6 + windowBps * 0.4 : windowBps;
    }
    return this.smoothedBps;
  }

  sampleSpeed(nowMs = Date.now(), holdMs = 3500): number {
    const idleMs = nowMs - this.lastProgressAtMs;
    if (idleMs <= 1200) {
      return this.smoothedBps;
    }
    if (idleMs >= holdMs) {
      this.smoothedBps = 0;
      return 0;
    }
    const ratio = 1 - (idleMs - 1200) / Math.max(1, holdMs - 1200);
    return Math.max(0, this.smoothedBps * ratio);
  }

  estimateEtaSeconds(
    uploadedBytes: number,
    totalBytes: number,
    nowMs = Date.now(),
  ): number | null {
    const speed = this.sampleSpeed(nowMs);
    if (speed <= 0 || totalBytes <= uploadedBytes) {
      return null;
    }
    return (totalBytes - uploadedBytes) / speed;
  }
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return '0 B/s';
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
    return 'Calculating…';
  }
  const rounded = Math.ceil(seconds);
  if (rounded < 60) {
    return `${rounded}s left`;
  }
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  if (mins < 60) {
    return `${mins}m ${secs}s left`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m left`;
}

export function isRetryableMobileError(error: unknown): boolean {
  if (error instanceof MyDriveApiError) {
    if (error.status === 0 || error.code === 'network_error') {
      return true;
    }
    return (
      error.status === 408 ||
      error.status === 429 ||
      error.status === 500 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504
    );
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('abort') || msg.includes('cancel')) {
      return false;
    }
    return (
      msg.includes('timed out') ||
      msg.includes('timeout') ||
      msg.includes('network') ||
      msg.includes('connection was lost') ||
      msg.includes('offline') ||
      msg.includes('broken pipe') ||
      msg.includes('connection reset') ||
      msg.includes('could not connect') ||
      msg.includes('http 5') ||
      msg.includes('http 429') ||
      msg.includes('http 408')
    );
  }
  return false;
}

export function mobileRetryDelayMs(attempt: number): number {
  const base = Math.min(10_000, 700 * Math.pow(2, Math.max(0, attempt - 1)));
  return base;
}
