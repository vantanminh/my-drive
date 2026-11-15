import assert from 'node:assert/strict';
import test from 'node:test';

import { MyDriveApiError, MyDriveClient } from '../src/services/apiClient.ts';
import {
  UploadThroughputTracker,
  formatEta,
  formatSpeed,
  isRetryableMobileError,
} from '../src/services/uploadTracker.ts';
import { uploadPreparedFile } from '../src/services/uploadWorkflow.ts';

test('UploadThroughputTracker smooths transfer rate, decays gently, and formats ETA', () => {
  const tracker = new UploadThroughputTracker(0, 1000);
  tracker.record(5 * 1024 * 1024, 1500);
  const speed = tracker.record(10 * 1024 * 1024, 2000);
  assert.ok(speed > 7 * 1024 * 1024 && speed <= 10 * 1024 * 1024);

  // Brief pause within 1.2s holds smoothed speed instead of flashing 0 MB/s.
  assert.equal(tracker.sampleSpeed(3000), speed);

  const eta = tracker.estimateEtaSeconds(10 * 1024 * 1024, 30 * 1024 * 1024, 2500);
  assert.ok(eta != null && eta > 1);
  assert.match(formatSpeed(speed), /MB\/s$/);
  assert.match(formatEta(65), /^1m 5s left$/);
  assert.equal(formatEta(null), 'Calculating…');

  // Mid-decay (~2.35s idle -> smoothly halved rather than 0).
  const decayed = tracker.sampleSpeed(4350);
  assert.ok(decayed > 0 && decayed < speed);

  // Past 3.5s idle threshold: settles back to 0.
  assert.equal(tracker.sampleSpeed(5600), 0);
});

test('isRetryableMobileError retries transient network/5xx faults but rejects permanent failures', () => {
  assert.equal(isRetryableMobileError(new MyDriveApiError(0, 'network_error')), true);
  assert.equal(isRetryableMobileError(new MyDriveApiError(503, 'busy')), true);
  assert.equal(isRetryableMobileError(new MyDriveApiError(429, 'rate_limited')), true);
  assert.equal(isRetryableMobileError(new Error('The request timed out.')), true);
  assert.equal(isRetryableMobileError(new MyDriveApiError(413, 'quota_exceeded')), false);
  assert.equal(isRetryableMobileError(new Error('Operation cancelled by user')), false);
});

test('uploadPreparedFile resumes from server HEAD offset and retries transient finalize faults', async () => {
  let headCalls = 0;
  let finalizeCalls = 0;
  let lastUploadStartOffset = -1;

  const client = new MyDriveClient({
    baseUrl: 'https://nas.local:8080',
    csrfToken: 'csrf_test',
    fetchImpl: async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/backup/check')) {
        return new Response(
          JSON.stringify({
            action: 'upload',
            file_id: null,
            version_id: null,
            remote_checksum: null,
            reusable: false,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/uploads')) {
        return new Response(JSON.stringify({ id: 'up_mobile_1', offset: 0, length: 4_194_304 }), {
          status: 201,
        });
      }
      if (url.endsWith('/api/uploads/up_mobile_1') && method === 'HEAD') {
        headCalls += 1;
        return new Response(null, {
          status: 200,
          headers: { 'Upload-Offset': '2097152' },
        });
      }
      if (url.endsWith('/api/uploads/up_mobile_1/finalize')) {
        finalizeCalls += 1;
        if (finalizeCalls === 1) {
          return new Response(
            JSON.stringify({ error: { code: 'busy', message: 'Temporary database lock' } }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ file_id: 'file_mobile_1', status: 'completed' }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    },
  });

  const phases: string[] = [];
  let chunkCalls = 0;
  const result = await uploadPreparedFile({
    client,
    parentId: null,
    filename: 'video.mov',
    fileUri: 'file:///tmp/video.mov',
    sizeBytes: 4_194_304,
    sha256: 'abc123',
    onPhase: (ev) => phases.push(ev.phase),
    uploadChunks: async (_uploadId, startOffset, expectedSize, _uri, onProgress) => {
      chunkCalls += 1;
      lastUploadStartOffset = startOffset;
      if (chunkCalls === 1) {
        throw new Error('The network connection was lost.');
      }
      onProgress?.(expectedSize, expectedSize);
      return expectedSize;
    },
  });

  assert.equal(result.fileId, 'file_mobile_1');
  assert.equal(result.mode, 'uploaded');
  assert.equal(headCalls, 1);
  assert.equal(lastUploadStartOffset, 2_097_152);
  assert.equal(finalizeCalls, 2);
  assert.ok(phases.includes('retrying'));
  assert.ok(phases.includes('finalizing'));
});
