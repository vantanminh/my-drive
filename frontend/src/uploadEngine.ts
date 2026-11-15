import { ApiError } from './api';

export const ADAPTIVE_CHUNK_SIZES = [
  1 * 1024 * 1024,
  2 * 1024 * 1024,
  4 * 1024 * 1024,
  8 * 1024 * 1024,
  16 * 1024 * 1024,
] as const;

export const INITIAL_CHUNK_INDEX = 2; // 4 MiB default starting chunk size
export const MAX_TRANSIENT_CHUNK_RETRIES = 5;
export const MAX_TRANSIENT_FINALIZE_RETRIES = 3;

export type UploadTransferPhase = 'uploading' | 'committing' | 'retrying' | 'finalizing';

export interface UploadPhaseEvent {
  phase: UploadTransferPhase;
  detail: string;
  offset: number;
  chunkSize: number;
  retryAttempt: number;
  retryMax: number;
}

/**
 * Rolling time-window + EWMA throughput estimator that avoids abrupt drops to
 * 0 B/s during chunk commits and short network pauses while decaying cleanly
 * if no bytes move for multiple seconds.
 */
export class ThroughputTracker {
  private samples: Array<{ timeMs: number; bytes: number }> = [];
  private smoothedBps = 0;
  private lastProgressAtMs: number;

  constructor(initialBytes = 0, nowMs = Date.now()) {
    this.samples.push({ timeMs: nowMs, bytes: Math.max(0, initialBytes) });
    this.lastProgressAtMs = nowMs;
  }

  reset(bytes: number, nowMs = Date.now()): void {
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

    // Retain a 3-second rolling window for steady measurements.
    const cutoff = nowMs - 3000;
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
    // Gentle linear decay between 1.2s and 3.5s instead of snapping to 0.
    const ratio = 1 - (idleMs - 1200) / Math.max(1, holdMs - 1200);
    return Math.max(0, this.smoothedBps * ratio);
  }
}

export function chooseNextChunkIndex(
  currentIndex: number,
  bytesSent: number,
  durationMs: number,
  hadFailure: boolean,
): number {
  const clamped = Math.max(0, Math.min(ADAPTIVE_CHUNK_SIZES.length - 1, currentIndex));
  if (hadFailure) {
    return Math.max(0, clamped - 1);
  }
  const safeDurationSec = Math.max(0.05, durationMs / 1000);
  const throughputBps = bytesSent / safeDurationSec;
  // Scale up on fast stable links (>= 10 MiB/s and quick chunk turn-around).
  if (durationMs <= 1800 && throughputBps >= 10 * 1024 * 1024) {
    return Math.min(ADAPTIVE_CHUNK_SIZES.length - 1, clamped + 1);
  }
  // Scale down when links slow or a chunk takes too long.
  if (durationMs >= 10_000 || throughputBps < 1.5 * 1024 * 1024) {
    return Math.max(0, clamped - 1);
  }
  return clamped;
}

export function isRetryableUploadError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return false;
  }
  if (error instanceof ApiError) {
    if (error.status === 0 || error.code === 'network_error' || error.code === 'upload_stalled') {
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
  return error instanceof TypeError;
}

export function retryDelayMs(attempt: number, error?: unknown): number {
  if (error instanceof ApiError && error.retryAfter) {
    const seconds = Number(error.retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(30_000, Math.ceil(seconds * 1000));
    }
  }
  const base = Math.min(12_000, 600 * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The upload was aborted.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('The upload was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ResilientChunkTransport {
  uploadHead(id: string): Promise<{ offset: number; length: number }>;
  uploadChunk(
    id: string,
    offset: number,
    chunk: Blob,
    onProgress?: (loadedBytes: number, totalBytes: number) => void,
    signal?: AbortSignal,
  ): Promise<number>;
}

export async function uploadFileChunksResilient(params: {
  file: Blob;
  sessionId: string;
  initialOffset?: number;
  transport: ResilientChunkTransport;
  signal?: AbortSignal;
  onProgress?: (uploadedBytes: number) => void;
  onOffsetCommitted?: (offset: number) => void;
  onPhase?: (event: UploadPhaseEvent) => void;
}): Promise<number> {
  const {
    file,
    sessionId,
    transport,
    signal,
    onProgress,
    onOffsetCommitted,
    onPhase,
  } = params;

  let offset = Math.max(0, Math.min(file.size, params.initialOffset ?? 0));
  let chunkIndex = INITIAL_CHUNK_INDEX;
  let transientFailures = 0;
  let mismatchCount = 0;

  while (offset < file.size) {
    if (signal?.aborted) {
      throw new DOMException('The upload was aborted.', 'AbortError');
    }

    const chunkSize = ADAPTIVE_CHUNK_SIZES[chunkIndex];
    const end = Math.min(offset + chunkSize, file.size);
    const slice = file.slice(offset, end);
    const startedAt = Date.now();
    const chunkMb = Math.round(slice.size / (1024 * 1024) * 10) / 10;

    onPhase?.({
      phase: 'uploading',
      detail: `Uploading (${chunkMb >= 1 ? `${Math.round(chunkMb)} MB` : '<1 MB'} chunk)…`,
      offset,
      chunkSize: slice.size,
      retryAttempt: transientFailures,
      retryMax: MAX_TRANSIENT_CHUNK_RETRIES,
    });

    try {
      const nextOffset = await transport.uploadChunk(
        sessionId,
        offset,
        slice,
        (loadedBytes) => {
          onProgress?.(Math.min(file.size, offset + loadedBytes));
          if (loadedBytes >= slice.size) {
            onPhase?.({
              phase: 'committing',
              detail: 'Saving chunk on NAS…',
              offset,
              chunkSize: slice.size,
              retryAttempt: transientFailures,
              retryMax: MAX_TRANSIENT_CHUNK_RETRIES,
            });
          }
        },
        signal,
      );

      const durationMs = Math.max(1, Date.now() - startedAt);
      offset = Math.min(file.size, Math.max(offset + slice.size, nextOffset));
      transientFailures = 0;
      mismatchCount = 0;
      chunkIndex = chooseNextChunkIndex(chunkIndex, slice.size, durationMs, false);
      onOffsetCommitted?.(offset);
      onProgress?.(offset);
    } catch (cause) {
      if (signal?.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) {
        throw cause;
      }

      if (cause instanceof ApiError && cause.status === 409 && cause.code === 'offset_mismatch') {
        mismatchCount += 1;
        if (mismatchCount > 3) throw cause;
        if (cause.offset != null && cause.offset !== offset) {
          offset = Math.max(0, Math.min(file.size, cause.offset));
        } else {
          const server = await transport.uploadHead(sessionId);
          if (server.offset === offset) throw cause;
          offset = Math.max(0, Math.min(file.size, server.offset));
        }
        chunkIndex = chooseNextChunkIndex(chunkIndex, 0, 0, true);
        onOffsetCommitted?.(offset);
        onProgress?.(offset);
        continue;
      }

      if (!isRetryableUploadError(cause) || transientFailures >= MAX_TRANSIENT_CHUNK_RETRIES) {
        throw cause;
      }

      transientFailures += 1;
      chunkIndex = chooseNextChunkIndex(chunkIndex, 0, 0, true);
      const waitMs = retryDelayMs(transientFailures, cause);

      // Reconcile server offset before retrying so already-committed chunks aren't re-sent.
      try {
        const server = await transport.uploadHead(sessionId);
        offset = Math.max(0, Math.min(file.size, server.offset));
        onOffsetCommitted?.(offset);
        onProgress?.(offset);
      } catch {
        // Keep last committed offset; the retry PATCH or 409 will reconcile once online.
      }

      onPhase?.({
        phase: 'retrying',
        detail: `Connection interrupted. Retrying chunk (${transientFailures}/${MAX_TRANSIENT_CHUNK_RETRIES}) in ${(waitMs / 1000).toFixed(1)}s…`,
        offset,
        chunkSize: ADAPTIVE_CHUNK_SIZES[chunkIndex],
        retryAttempt: transientFailures,
        retryMax: MAX_TRANSIENT_CHUNK_RETRIES,
      });

      await sleepAbortable(waitMs, signal);
    }
  }

  return offset;
}

export async function finalizeUploadWithRetry<T>(
  finalize: () => Promise<T>,
  signal?: AbortSignal,
  onRetry?: (attempt: number, max: number, waitMs: number) => void,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await finalize();
    } catch (cause) {
      if (
        signal?.aborted ||
        !isRetryableUploadError(cause) ||
        attempt >= MAX_TRANSIENT_FINALIZE_RETRIES
      ) {
        throw cause;
      }
      attempt += 1;
      const waitMs = retryDelayMs(attempt, cause);
      onRetry?.(attempt, MAX_TRANSIENT_FINALIZE_RETRIES, waitMs);
      await sleepAbortable(waitMs, signal);
    }
  }
}
