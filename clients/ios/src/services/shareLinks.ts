import type { ShareSummary } from '../types/mydrive';

export type ShareLifecycleStatus =
  | 'active'
  | 'expiring_soon'
  | 'expired'
  | 'revoked'
  | 'exhausted';

export type ShareFilterKey =
  | 'all'
  | 'active'
  | 'expiring_soon'
  | 'protected'
  | 'inactive';

export type ShareSortKey =
  | 'newest'
  | 'most_downloaded'
  | 'expiring_soon'
  | 'last_accessed';

export interface CachedShareUrlEntry {
  url: string;
  createdAt: string;
}

const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000;

export function buildPublicShareUrl(baseUrl: string, sharePath: string): string {
  const origin = baseUrl.replace(/\/+$/, '');
  const path = sharePath.startsWith('/') ? sharePath : `/${sharePath}`;
  return `${origin}${path}`;
}

export function classifyShareStatus(
  share: ShareSummary,
  nowMs = Date.now(),
): ShareLifecycleStatus {
  if (share.revoked_at) return 'revoked';
  if (share.expires_at) {
    const expiresMs = new Date(share.expires_at).getTime();
    if (!Number.isNaN(expiresMs)) {
      if (expiresMs <= nowMs) return 'expired';
      if (expiresMs - nowMs <= EXPIRING_SOON_MS) return 'expiring_soon';
    }
  }
  if (share.max_downloads != null && share.download_count >= share.max_downloads) {
    return 'exhausted';
  }
  return 'active';
}

export function isShareActive(share: ShareSummary, nowMs = Date.now()): boolean {
  const status = classifyShareStatus(share, nowMs);
  return status === 'active' || status === 'expiring_soon';
}

export function formatExpiryCountdown(
  expiresAt: string | null,
  nowMs = Date.now(),
): string {
  if (!expiresAt) return 'No expiry';
  const targetMs = new Date(expiresAt).getTime();
  if (Number.isNaN(targetMs)) return 'Unknown';
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return 'Expired';
  const totalMinutes = Math.floor(diffMs / 60_000);
  if (totalMinutes < 60) {
    return `${Math.max(1, totalMinutes)}m left`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const remMins = totalMinutes % 60;
    return remMins > 0 ? `${totalHours}h ${remMins}m left` : `${totalHours}h left`;
  }
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${days}d ${remHours}h left` : `${days}d left`;
}

export function filterAndSortShares(
  shares: ShareSummary[],
  options: {
    query?: string;
    filter?: ShareFilterKey;
    sort?: ShareSortKey;
    nowMs?: number;
  } = {},
): ShareSummary[] {
  const nowMs = options.nowMs ?? Date.now();
  const q = (options.query ?? '').trim().toLowerCase();
  const filter = options.filter ?? 'all';
  const sort = options.sort ?? 'newest';

  const filtered = shares.filter((share) => {
    if (q && !share.resource_name.toLowerCase().includes(q)) {
      return false;
    }
    const status = classifyShareStatus(share, nowMs);
    switch (filter) {
      case 'active':
        return status === 'active' || status === 'expiring_soon';
      case 'expiring_soon':
        return status === 'expiring_soon';
      case 'protected':
        return share.password_protected && (status === 'active' || status === 'expiring_soon');
      case 'inactive':
        return status === 'expired' || status === 'revoked' || status === 'exhausted';
      case 'all':
      default:
        return true;
    }
  });

  return [...filtered].sort((a, b) => {
    switch (sort) {
      case 'most_downloaded':
        if (b.download_count !== a.download_count) {
          return b.download_count - a.download_count;
        }
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      case 'expiring_soon': {
        const aActive = isShareActive(a, nowMs) ? 0 : 1;
        const bActive = isShareActive(b, nowMs) ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        const aExp = a.expires_at ? new Date(a.expires_at).getTime() : Number.MAX_SAFE_INTEGER;
        const bExp = b.expires_at ? new Date(b.expires_at).getTime() : Number.MAX_SAFE_INTEGER;
        return aExp - bExp;
      }
      case 'last_accessed': {
        const aAcc = a.last_accessed_at ? new Date(a.last_accessed_at).getTime() : 0;
        const bAcc = b.last_accessed_at ? new Date(b.last_accessed_at).getTime() : 0;
        if (bAcc !== aAcc) return bAcc - aAcc;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      case 'newest':
      default:
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    }
  });
}
