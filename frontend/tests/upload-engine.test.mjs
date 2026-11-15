import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

function transpileToDataUrl(source) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return 'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64');
}

async function loadModules() {
  const apiSource = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
  const apiUrl = transpileToDataUrl(apiSource);
  const engineSource = (await readFile(new URL('../src/uploadEngine.ts', import.meta.url), 'utf8')).replace(
    "from './api'",
    `from '${apiUrl}'`,
  );
  const [apiMod, engineMod] = await Promise.all([
    import(apiUrl),
    import(transpileToDataUrl(engineSource)),
  ]);
  return { ...apiMod, ...engineMod };
}

test('ThroughputTracker smooths bursty writes and decays smoothly during brief pauses', async () => {
  const { ThroughputTracker } = await loadModules();
  const tracker = new ThroughputTracker(0, 1000);

  // 20 MiB over 1s
  tracker.record(10 * 1024 * 1024, 1500);
  const speed1 = tracker.record(20 * 1024 * 1024, 2000);
  assert.ok(speed1 > 15 * 1024 * 1024 && speed1 <= 20 * 1024 * 1024);

  // Within 1.2s of last progress: speed holds steady rather than dropping to 0.
  assert.equal(tracker.sampleSpeed(3000), speed1);

  // Mid-decay (~2.35s idle -> roughly half speed, not 0).
  const decayed = tracker.sampleSpeed(4350);
  assert.ok(decayed > 0 && decayed < speed1, `expected smooth decay, got ${decayed}`);

  // Past hold window (>= 3.5s idle): decays cleanly to 0.
  assert.equal(tracker.sampleSpeed(5600), 0);
});

test('chooseNextChunkIndex scales up on fast links and backs off on slow links or errors', async () => {
  const { ADAPTIVE_CHUNK_SIZES, INITIAL_CHUNK_INDEX, chooseNextChunkIndex } = await loadModules();

  const fastNext = chooseNextChunkIndex(INITIAL_CHUNK_INDEX, 8 * 1024 * 1024, 400, false);
  assert.equal(fastNext, INITIAL_CHUNK_INDEX + 1);

  const errorNext = chooseNextChunkIndex(fastNext, 0, 0, true);
  assert.equal(errorNext, INITIAL_CHUNK_INDEX);

  const slowNext = chooseNextChunkIndex(INITIAL_CHUNK_INDEX, 512 * 1024, 2000, false);
  assert.equal(slowNext, INITIAL_CHUNK_INDEX - 1);

  assert.equal(chooseNextChunkIndex(0, 0, 0, true), 0);
  assert.equal(
    chooseNextChunkIndex(ADAPTIVE_CHUNK_SIZES.length - 1, 64 * 1024 * 1024, 500, false),
    ADAPTIVE_CHUNK_SIZES.length - 1,
  );
});

test('isRetryableUploadError classifies transient errors vs permanent and abort errors', async () => {
  const { ApiError, isRetryableUploadError } = await loadModules();

  assert.equal(isRetryableUploadError(new ApiError(0, 'network_error', 'Offline')), true);
  assert.equal(isRetryableUploadError(new ApiError(0, 'upload_stalled', 'Stalled')), true);
  assert.equal(isRetryableUploadError(new ApiError(503, 'busy', 'Service unavailable')), true);
  assert.equal(isRetryableUploadError(new ApiError(429, 'rate_limited', 'Slow down')), true);
  assert.equal(isRetryableUploadError(new ApiError(413, 'quota_exceeded', 'Full')), false);
  assert.equal(isRetryableUploadError(new ApiError(403, 'forbidden', 'Denied')), false);
  assert.equal(isRetryableUploadError(new DOMException('Aborted', 'AbortError')), false);
});

test('uploadFileChunksResilient recovers from 409 offset mismatch and transient stalls via HEAD sync', async () => {
  const { ApiError, uploadFileChunksResilient } = await loadModules();
  const payload = new Uint8Array(6 * 1024 * 1024);
  const blob = new Blob([payload]);

  let serverOffset = 0;
  let attempts = 0;
  const phases = [];
  const committed = [];

  const finalOffset = await uploadFileChunksResilient({
    file: blob,
    sessionId: 'up_1',
    initialOffset: 0,
    onPhase: (event) => phases.push(event.phase),
    onOffsetCommitted: (offset) => committed.push(offset),
    transport: {
      async uploadHead() {
        return { offset: serverOffset, length: blob.size };
      },
      async uploadChunk(_id, offset, chunk, onProgress) {
        attempts += 1;
        // 1st attempt: pretend first 2 MiB was already committed on NAS (409 mismatch).
        if (attempts === 1) {
          serverOffset = 2 * 1024 * 1024;
          throw new ApiError(409, 'offset_mismatch', 'Offset mismatch', null, serverOffset);
        }
        // 2nd attempt: transient stalled socket after 1 MiB actually committed on NAS.
        if (attempts === 2) {
          serverOffset = offset + 1024 * 1024;
          throw new ApiError(503, 'upload_stalled', 'Stalled', '0.01');
        }
        onProgress?.(chunk.size, chunk.size);
        serverOffset = offset + chunk.size;
        return serverOffset;
      },
    },
  });

  assert.equal(finalOffset, blob.size);
  assert.equal(serverOffset, blob.size);
  assert.ok(phases.includes('retrying'));
  assert.ok(committed.includes(blob.size));
});

test('finalizeUploadWithRetry retries transient errors and throws permanent errors immediately', async () => {
  const { ApiError, finalizeUploadWithRetry } = await loadModules();
  let finalizeCalls = 0;
  const retries = [];

  const result = await finalizeUploadWithRetry(
    async () => {
      finalizeCalls += 1;
      if (finalizeCalls < 3) {
        throw new ApiError(503, 'busy', 'Wait', '0.01');
      }
      return { id: 'file_123' };
    },
    undefined,
    (attempt) => retries.push(attempt),
  );

  assert.deepEqual(result, { id: 'file_123' });
  assert.deepEqual(retries, [1, 2]);

  await assert.rejects(
    finalizeUploadWithRetry(async () => {
      throw new ApiError(400, 'size_mismatch', 'Incomplete');
    }),
    (err) => err instanceof ApiError && err.status === 400,
  );
});
