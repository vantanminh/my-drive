import type { MyDriveClient } from './apiClient';

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
}): Promise<PreparedTransferResult> {
  const { client, uploadChunks, parentId, filename, fileUri, sizeBytes, sha256, modifiedAtIso, onProgress } = params;

  const check = await client.checkBackupContent({
    parent_id: parentId,
    name: filename,
    size_bytes: sizeBytes,
    checksum_sha256: sha256,
  });

  if (check.action === 'skip' && check.file_id) {
    onProgress?.(sizeBytes, sizeBytes);
    return { fileId: check.file_id, mode: 'skipped' };
  }

  if (check.action === 'link') {
    const linked = await client.linkBackupContent({
      parent_id: parentId,
      name: filename,
      size_bytes: sizeBytes,
      checksum_sha256: sha256,
      modified_at: modifiedAtIso,
    });
    onProgress?.(sizeBytes, sizeBytes);
    return {
      fileId: linked.file_id,
      mode: linked.unchanged ? 'skipped' : 'deduplicated',
    };
  }

  const created = await client.createUpload({
    filename,
    expected_size: sizeBytes,
    parent_id: parentId,
    file_id: check.file_id,
    original_modified_at: modifiedAtIso,
  });

  await uploadChunks(created.id, created.offset, sizeBytes, fileUri, onProgress);

  const finalized = await client.finalizeUpload(created.id, sha256);
  onProgress?.(sizeBytes, sizeBytes);
  return { fileId: finalized.file_id, mode: 'uploaded' };
}
