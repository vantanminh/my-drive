import { api } from './api';

const CHUNK_SIZE = 8 * 1024 * 1024;

export async function uploadFile(
  file: File,
  parentId: string | null,
  onProgress?: (loadedBytes: number, totalBytes: number) => void
): Promise<string> {
  const created = await api.createUpload(file.name, file.size, parentId);
  let offset = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(file.size, offset + CHUNK_SIZE));
    await api.uploadChunk(created.id, offset, chunk, (loaded) => {
      onProgress?.(Math.min(file.size, offset + loaded), file.size);
    });
    offset += chunk.size;
  }
  onProgress?.(file.size, file.size);
  const finalized = await api.finalizeUpload(created.id);
  return finalized.file_id;
}
