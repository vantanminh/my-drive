import type { MyDriveClient } from './apiClient';
import { isRetryableMobileError, mobileRetryDelayMs } from './uploadTracker';

export type ChunkUploader = (
  uploadId: string,
  startOffset: number,
  expectedSize: number,
  fileUri: string,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
) => Promise<number>;

export interface PreparedTransferResult {
  fileId: string;
  mode: 'skipped' | 'deduplicated' | 'uploaded';
}

export interface UploadWorkflowPhaseEvent {
  phase: 'uploading' | 'retrying' | 'finalizing';
  detail: string;
  retryAttempt: number;
  retryMax: number;
}

const MAX_METADATA_RETRIES = 3;
const MAX_UPLOAD_RESUME_RETRIES = 3;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTransientRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number,
  onRetry?: (attempt: number, waitMs: number) => void,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableMobileError(error) || attempt >= maxRetries) {
        throw error;
      }
      attempt += 1;
      const waitMs = mobileRetryDelayMs(attempt);
      onRetry?.(attempt, waitMs);
      await sleepMs(waitMs);
    }
  }
}

/**
 * Uploads or deduplicates an already-hashed local file into MyDrive using
 * `/api/backup/check`, `/api/backup/link`, and resumable `/api/uploads`.
 */
export async function uploadPreparedFile(params: {
  client: MyDriveClient;
  uploadChunks: ChunkUploader;
  parentId: string | null;
  filename: string;
  fileUri: string;
  sizeBytes: number;
  sha256: string;
  modifiedAtIso?: string | null;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  onPhase?: (event: UploadWorkflowPhaseEvent) => void;
}): Promise<PreparedTransferResult> {
  const {
    client,
    uploadChunks,
    parentId,
    filename,
    fileUri,
    sizeBytes,
    sha256,
    modifiedAtIso,
    onProgress,
    onPhase,
  } = params;

  const check = await withTransientRetry(
    () =>
      client.checkBackupContent({
        parent_id: parentId,
        name: filename,
        size_bytes: sizeBytes,
        checksum_sha256: sha256,
      }),
    MAX_METADATA_RETRIES,
  );

  if (check.action === 'skip' && check.file_id) {
    onProgress?.(sizeBytes, sizeBytes);
    return { fileId: check.file_id, mode: 'skipped' };
  }

  if (check.action === 'link') {
    const linked = await withTransientRetry(
      () =>
        client.linkBackupContent({
          parent_id: parentId,
          name: filename,
          size_bytes: sizeBytes,
          checksum_sha256: sha256,
          modified_at: modifiedAtIso,
        }),
      MAX_METADATA_RETRIES,
    );
    onProgress?.(sizeBytes, sizeBytes);
    return {
      fileId: linked.file_id,
      mode: linked.unchanged ? 'skipped' : 'deduplicated',
    };
  }

  const created = await withTransientRetry(
    () =>
      client.createUpload({
        filename,
        expected_size: sizeBytes,
        parent_id: parentId,
        file_id: check.file_id,
        original_modified_at: modifiedAtIso,
      }),
    MAX_METADATA_RETRIES,
  );

  let nextOffset = created.offset;
  let uploadRetries = 0;
  while (true) {
    onPhase?.({
      phase: 'uploading',
      detail: 'Uploading chunks to NAS…',
      retryAttempt: uploadRetries,
      retryMax: MAX_UPLOAD_RESUME_RETRIES,
    });
    try {
      await uploadChunks(created.id, nextOffset, sizeBytes, fileUri, onProgress);
      break;
    } catch (error) {
      if (!isRetryableMobileError(error) || uploadRetries >= MAX_UPLOAD_RESUME_RETRIES) {
        throw error;
      }
      uploadRetries += 1;
      try {
        const syncedOffset = await client.headUploadOffset(created.id);
        nextOffset = Math.max(0, Math.min(sizeBytes, syncedOffset));
        onProgress?.(nextOffset, sizeBytes);
      } catch {
        // Retry from last known offset if HEAD also dropped momentarily.
      }
      const waitMs = mobileRetryDelayMs(uploadRetries);
      onPhase?.({
        phase: 'retrying',
        detail: `Connection interrupted. Retrying (${uploadRetries}/${MAX_UPLOAD_RESUME_RETRIES})…`,
        retryAttempt: uploadRetries,
        retryMax: MAX_UPLOAD_RESUME_RETRIES,
      });
      await sleepMs(waitMs);
    }
  }

  onPhase?.({
    phase: 'finalizing',
    detail: 'Verifying checksum on NAS…',
    retryAttempt: 0,
    retryMax: MAX_METADATA_RETRIES,
  });

  const finalized = await withTransientRetry(
    () => client.finalizeUpload(created.id, sha256),
    MAX_METADATA_RETRIES,
    (attempt) => {
      onPhase?.({
        phase: 'retrying',
        detail: `Finalizing retry (${attempt}/${MAX_METADATA_RETRIES})…`,
        retryAttempt: attempt,
        retryMax: MAX_METADATA_RETRIES,
      });
    },
  );
  onProgress?.(sizeBytes, sizeBytes);
  return { fileId: finalized.file_id, mode: 'uploaded' };
}
