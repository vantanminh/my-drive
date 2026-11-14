const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${SIZE_UNITS[unitIndex]}`;
}

export function formatShortDate(isoOrMs: string | number | null | undefined): string {
  if (isoOrMs == null) return '';
  const date = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(isoOrMs: string | number | null | undefined): string {
  if (isoOrMs == null) return '';
  const date = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  const hours = Math.floor(mins / 60);
  if (hours > 0) {
    const remMins = mins % 60;
    return `${hours}:${String(remMins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'dng', 'raw',
]);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'mts', 'm2ts', 'mpg', 'mpeg']);
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'log', 'yaml', 'yml', 'xml', 'toml', 'ini', 'sh']);
const OFFICE_EXTS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'csv']);

export type ViewerKind = 'image' | 'video' | 'pdf' | 'office' | 'text' | 'binary';

export function resolveViewerKind(name: string, mime?: string | null, category?: string | null): ViewerKind {
  const ext = extensionOf(name);
  const lowerMime = (mime ?? '').toLowerCase();
  if (category === 'image' || lowerMime.startsWith('image/') || IMAGE_EXTS.has(ext)) {
    return 'image';
  }
  if (category === 'video' || lowerMime.startsWith('video/') || VIDEO_EXTS.has(ext)) {
    return 'video';
  }
  if (ext === 'pdf' || lowerMime === 'application/pdf') {
    return 'pdf';
  }
  if (OFFICE_EXTS.has(ext)) {
    return 'office';
  }
  if (
    TEXT_EXTS.has(ext) ||
    lowerMime.startsWith('text/') ||
    lowerMime === 'application/json'
  ) {
    return 'text';
  }
  return 'binary';
}
