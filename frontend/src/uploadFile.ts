import { api } from './api';
import {
  finalizeUploadWithRetry,
  uploadFileChunksResilient,
} from './uploadEngine';

export async function uploadFile(
  file: File,
  parentId: string | null,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const created = await api.createUpload(file.name, file.size, parentId);
  await uploadFileChunksResilient({
    file,
    sessionId: created.id,
    initialOffset: created.offset,
    transport: api,
    signal,
    onProgress: (uploadedBytes) => {
      onProgress?.(uploadedBytes, file.size);
    },
  });
  onProgress?.(file.size, file.size);
  const finalized = await finalizeUploadWithRetry(
    () => api.finalizeUpload(created.id),
    signal,
  );
  return finalized.file_id;
}
