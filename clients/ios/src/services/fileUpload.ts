import {
  addUploadProgressListener,
  hashFileSha256,
  uploadFileChunked,
} from '../../modules/mydrive-media-sync/src';
import type { MyDriveClient } from './apiClient';
import {
  type UploadWorkflowPhaseEvent,
  type ChunkUploader,
  type PreparedTransferResult,
  uploadPreparedFile,
} from './uploadWorkflow';

export {
  type ChunkUploader,
  type PreparedTransferResult,
  type UploadWorkflowPhaseEvent,
  uploadPreparedFile,
} from './uploadWorkflow';

export function createNativeChunkUploader(client: MyDriveClient): ChunkUploader {
  return async (uploadId, startOffset, expectedSize, fileUri, onProgress) => {
    if (expectedSize === 0) {
      onProgress?.(0, 0);
      return 0;
    }
    const subscription = addUploadProgressListener((event) => {
      if (event.uploadId === uploadId) {
        onProgress?.(event.uploadedBytes, event.totalBytes);
      }
    });
    try {
      return await uploadFileChunked({
        baseUrl: client.getBaseUrl(),
        uploadId,
        fileUri,
        startOffset,
        chunkSize: 2 * 1024 * 1024,
        csrfToken: client.getCsrfToken(),
      });
    } finally {
      subscription.remove();
    }
  };
}

/**
 * Hashes and uploads a file picked from the iOS Files / Document Picker.
 */
export async function uploadLocalDocument(params: {
  client: MyDriveClient;
  parentId: string | null;
  filename: string;
  fileUri: string;
  modifiedAtIso?: string | null;
  onPhase?: (
    phase: 'hashing' | 'uploading' | 'retrying' | 'finalizing',
    progress: number,
    bytes?: { uploadedBytes: number; totalBytes: number; detail?: string },
  ) => void;
}): Promise<PreparedTransferResult> {
  params.onPhase?.('hashing', 0);
  const { sha256, sizeBytes } = await hashFileSha256(params.fileUri);
  let lastUploaded = 0;
  let lastPhase: 'uploading' | 'retrying' | 'finalizing' = 'uploading';
  let lastDetail = 'Uploading chunks to NAS…';
  params.onPhase?.('uploading', 0, {
    uploadedBytes: 0,
    totalBytes: sizeBytes,
    detail: lastDetail,
  });

  return uploadPreparedFile({
    client: params.client,
    uploadChunks: createNativeChunkUploader(params.client),
    parentId: params.parentId,
    filename: params.filename,
    fileUri: params.fileUri,
    sizeBytes,
    sha256,
    modifiedAtIso: params.modifiedAtIso,
    onProgress: (uploaded, total) => {
      lastUploaded = uploaded;
      const ratio = total > 0 ? Math.min(1, uploaded / total) : 1;
      params.onPhase?.(lastPhase, ratio, {
        uploadedBytes: uploaded,
        totalBytes: total > 0 ? total : sizeBytes,
        detail: lastDetail,
      });
    },
    onPhase: (ev: UploadWorkflowPhaseEvent) => {
      lastPhase = ev.phase;
      lastDetail = ev.detail;
      const ratio = sizeBytes > 0 ? Math.min(1, lastUploaded / sizeBytes) : 1;
      params.onPhase?.(ev.phase, ratio, {
        uploadedBytes: lastUploaded,
        totalBytes: sizeBytes,
        detail: ev.detail,
      });
    },
  });
}
