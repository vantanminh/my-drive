import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPublicShareUrl,
  classifyShareStatus,
  filterAndSortShares,
  formatExpiryCountdown,
  isShareActive,
} from '../src/services/shareLinks';
import type { ShareSummary } from '../src/types/mydrive';

function makeShare(overrides: Partial<ShareSummary> = {}): ShareSummary {
  return {
    id: overrides.id ?? 'share-1',
    resource_type: overrides.resource_type ?? 'file',
    resource_id: overrides.resource_id ?? 'file-1',
    resource_name: overrides.resource_name ?? 'Report.pdf',
    created_at: overrides.created_at ?? '2026-05-01T10:00:00Z',
    expires_at: overrides.expires_at ?? null,
    password_protected: overrides.password_protected ?? false,
    allow_download: overrides.allow_download ?? true,
    max_downloads: overrides.max_downloads ?? null,
    download_count: overrides.download_count ?? 0,
    revoked_at: overrides.revoked_at ?? null,
    last_accessed_at: overrides.last_accessed_at ?? null,
  };
}

test('buildPublicShareUrl normalizes trailing slashes and missing leading slashes', () => {
  assert.equal(
    buildPublicShareUrl('https://nas.example.com///', '/s/abc123'),
    'https://nas.example.com/s/abc123',
  );
  assert.equal(
    buildPublicShareUrl('http://192.168.1.10:8080', 's/xyz'),
    'http://192.168.1.10:8080/s/xyz',
  );
});

test('classifyShareStatus distinguishes active, expiring_soon, expired, revoked, and exhausted', () => {
  const now = Date.parse('2026-05-10T12:00:00Z');

  assert.equal(classifyShareStatus(makeShare(), now), 'active');
  assert.equal(
    classifyShareStatus(makeShare({ expires_at: '2026-05-10T20:00:00Z' }), now),
    'expiring_soon',
  );
  assert.equal(
    classifyShareStatus(makeShare({ expires_at: '2026-05-10T11:59:00Z' }), now),
    'expired',
  );
  assert.equal(
    classifyShareStatus(makeShare({ revoked_at: '2026-05-09T00:00:00Z' }), now),
    'revoked',
  );
  assert.equal(
    classifyShareStatus(makeShare({ max_downloads: 3, download_count: 3 }), now),
    'exhausted',
  );

  assert.equal(isShareActive(makeShare({ expires_at: '2026-05-10T20:00:00Z' }), now), true);
  assert.equal(isShareActive(makeShare({ max_downloads: 1, download_count: 1 }), now), false);
});

test('formatExpiryCountdown renders compact remaining labels', () => {
  const now = Date.parse('2026-05-10T12:00:00Z');
  assert.equal(formatExpiryCountdown(null, now), 'No expiry');
  assert.equal(formatExpiryCountdown('2026-05-10T11:00:00Z', now), 'Expired');
  assert.equal(formatExpiryCountdown('2026-05-10T12:45:00Z', now), '45m left');
  assert.equal(formatExpiryCountdown('2026-05-10T17:30:00Z', now), '5h 30m left');
  assert.equal(formatExpiryCountdown('2026-05-13T14:00:00Z', now), '3d 2h left');
});

test('filterAndSortShares supports search query, lifecycle filters, and sort orders', () => {
  const now = Date.parse('2026-05-10T12:00:00Z');
  const shares: ShareSummary[] = [
    makeShare({
      id: 's1',
      resource_name: 'Taxes 2026.pdf',
      created_at: '2026-05-01T10:00:00Z',
      download_count: 2,
      password_protected: true,
    }),
    makeShare({
      id: 's2',
      resource_name: 'Trip Photos',
      resource_type: 'album',
      created_at: '2026-05-08T10:00:00Z',
      expires_at: '2026-05-10T18:00:00Z',
      download_count: 15,
      last_accessed_at: '2026-05-10T10:00:00Z',
    }),
    makeShare({
      id: 's3',
      resource_name: 'Old Archive.zip',
      created_at: '2026-05-09T10:00:00Z',
      revoked_at: '2026-05-09T12:00:00Z',
      download_count: 1,
    }),
  ];

  assert.deepEqual(
    filterAndSortShares(shares, { filter: 'active', nowMs: now }).map((s) => s.id),
    ['s2', 's1'],
  );
  assert.deepEqual(
    filterAndSortShares(shares, { filter: 'expiring_soon', nowMs: now }).map((s) => s.id),
    ['s2'],
  );
  assert.deepEqual(
    filterAndSortShares(shares, { filter: 'protected', nowMs: now }).map((s) => s.id),
    ['s1'],
  );
  assert.deepEqual(
    filterAndSortShares(shares, { filter: 'inactive', nowMs: now }).map((s) => s.id),
    ['s3'],
  );
  assert.deepEqual(
    filterAndSortShares(shares, { query: 'trip', nowMs: now }).map((s) => s.id),
    ['s2'],
  );
  assert.deepEqual(
    filterAndSortShares(shares, { sort: 'most_downloaded', nowMs: now }).map((s) => s.id),
    ['s2', 's1', 's3'],
  );
  assert.deepEqual(
    filterAndSortShares(shares, { sort: 'expiring_soon', nowMs: now }).map((s) => s.id),
    ['s2', 's1', 's3'],
  );
});
