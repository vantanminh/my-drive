import { ApiError } from './api';

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
    return 'Today, ' + new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

export function friendlyError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Check your connection and try again.';
  if (error.status === 403 && error.code === 'csrf_failed') return 'Your session token expired. Sign in again to continue.';
  const messages: Record<string, string> = {
    invalid_credentials: 'That email and password do not match.',
    current_password_incorrect: 'The current password is not correct.',
    credentials_changed: 'Your account changed during this request. Sign in again and retry.',
    email_exists: 'An account with this email address already exists.',
    owner_required: 'Only the owner can manage accounts.',
    quota_below_current_usage: 'The quota cannot be lower than the account’s current storage and active uploads.',
    password_change_required: 'Change your temporary password before using the drive.',
    password_requirements: 'Choose a different password with at least 12 characters.',
    too_many_attempts: 'Too many attempts. Wait a little before trying again.',
    invalid_request: 'Check the information and try again.',
    conflict: 'An item with that name already exists in this location.',
    not_found: 'This item is no longer available.',
    upload_closed: 'This upload session has expired. Start the upload again.',
    offset_mismatch: 'The upload position changed. It will resume from the server position.',
    payload_too_large: 'This file is larger than the configured upload limit.',
    quota_exceeded: 'There is not enough available drive quota for this file.',
    storage_low: 'There is not enough free space on the storage drive.',
    password_required: 'Enter the password to open this shared link.',
    invalid_password: 'That password is not correct.',
    download_disabled: 'The owner has disabled downloads for this link.',
    share_unavailable: 'This shared link has expired or was revoked.',
    service_unavailable: 'The service is temporarily unavailable. Try again shortly.',
    google_drive_unconfigured: 'Google Drive is not configured on this server yet.',
    google_drive_not_connected: 'Connect a Google account before choosing folders.',
    reauth_required: 'Google needs you to connect again.',
    too_many_folders: 'You can sync up to 20 Google Drive folders.',
    already_selected: 'That folder is already being synced.',
    google_auth_failed: 'Google did not accept the connection. Try again.',
    google_request_failed: 'Google Drive could not be reached. Try again shortly.'
  };
  if (messages[error.code]) return messages[error.code];
  if (error.status === 401) return 'Your session has ended. Sign in again to continue.';
  return 'The request could not be completed.';
}
