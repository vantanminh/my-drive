import { ApiError } from './api';
import { tGlobal } from './i18n';
import type { MessageKey } from './i18n';

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return value.toFixed(value >= 10 ? 0 : 1) + ' ' + units[unit];
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const sameDay = new Date().toDateString() === date.toDateString();
  if (sameDay) {
    return tGlobal('date.today_at', { time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date) });
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

// Maps API error codes onto the translated `err.*` dictionary entries.
const ERROR_CODE_KEYS: Record<string, MessageKey> = {
  invalid_credentials: 'err.invalid_credentials',
  current_password_incorrect: 'err.current_password_incorrect',
  credentials_changed: 'err.credentials_changed',
  email_exists: 'err.email_exists',
  owner_required: 'err.owner_required',
  quota_below_current_usage: 'err.quota_below_current_usage',
  password_change_required: 'err.password_change_required',
  password_requirements: 'err.password_requirements',
  too_many_attempts: 'err.too_many_attempts',
  expired_token: 'err.expired_token',
  access_denied: 'err.access_denied',
  insufficient_scope: 'err.insufficient_scope',
  content_not_found: 'err.content_not_found',
  invalid_request: 'err.invalid_request',
  conflict: 'err.conflict',
  protected_entry: 'err.protected_entry',
  not_found: 'err.not_found',
  upload_closed: 'err.upload_closed',
  offset_mismatch: 'err.offset_mismatch',
  upload_stalled: 'err.upload_stalled',
  network_error: 'err.network_error',
  payload_too_large: 'err.payload_too_large',
  quota_exceeded: 'err.quota_exceeded',
  storage_low: 'err.storage_low',
  password_required: 'err.password_required',
  invalid_password: 'err.invalid_password',
  download_disabled: 'err.download_disabled',
  share_unavailable: 'err.share_unavailable',
  service_unavailable: 'err.service_unavailable',
  google_drive_unconfigured: 'err.google_drive_unconfigured',
  invalid_google_settings: 'err.invalid_google_settings',
  google_drive_not_connected: 'err.google_drive_not_connected',
  reauth_required: 'err.reauth_required',
  too_many_folders: 'err.too_many_folders',
  already_selected: 'err.already_selected',
  google_auth_failed: 'err.google_auth_failed',
  google_request_failed: 'err.google_request_failed'
};

export function friendlyError(error: unknown): string {
  if (!(error instanceof ApiError)) return tGlobal('err.generic');
  if (error.status === 403 && error.code === 'csrf_failed') return tGlobal('err.csrf_failed');
  const key = ERROR_CODE_KEYS[error.code];
  if (key) return tGlobal(key);
  if (error.status === 401) return tGlobal('err.session_ended');
  return tGlobal('err.request_failed');
}
