import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

import {
  AppButton,
  Banner,
  Card,
  KeyValueRow,
  SectionTitle,
  StatusBadge,
} from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import {
  IMAGE_CACHE_LIMIT_PRESETS,
  TEMP_RETENTION_DAY_PRESETS,
  VIDEO_CACHE_LIMIT_PRESETS,
} from '../services/cacheManager';
import {
  clearAllCaches,
  clearCategoryCache,
  fetchCacheSnapshot,
  pruneExpiredCacheNow,
  removeCachedDownloadItem,
  updateCachePolicy,
} from '../services/cacheRuntime';
import type {
  CacheCategoryStats,
  CacheCleanupResult,
  CacheSettings,
  CacheSnapshot,
  CachedFileEntry,
} from '../services/cacheTypes';
import { formatBytes, formatDateTime } from '../services/format';
import { colors, radius, spacing } from '../theme/tokens';

function categoryIconName(icon: string): keyof typeof Ionicons.glyphMap {
  return icon as keyof typeof Ionicons.glyphMap;
}

export function CacheManagementScreen() {
  const { user } = useAuth();
  const { snapshot: syncSnap, ledgerStats } = useSync();

  const [cacheSnap, setCacheSnap] = useState<CacheSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: 'success' | 'warning' | 'danger';
    message: string;
  } | null>(null);

  const loadSnapshot = useCallback(async () => {
    try {
      const next = await fetchCacheSnapshot({ syncRunning: syncSnap.running });
      setCacheSnap(next);
    } catch (err) {
      setFeedback({
        tone: 'danger',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [syncSnap.running]);

  useFocusEffect(
    useCallback(() => {
      void loadSnapshot();
    }, [loadSnapshot]),
  );

  const applyCleanupOutcome = (label: string, res: CacheCleanupResult) => {
    setCacheSnap(res.snapshot);
    const freedText =
      res.freedBytes > 0
        ? `Freed ${formatBytes(res.freedBytes)}${res.freedFiles > 0 ? ` (${res.freedFiles} ${res.freedFiles === 1 ? 'file' : 'files'})` : ''}.`
        : res.freedFiles > 0
          ? `Removed ${res.freedFiles} cached ${res.freedFiles === 1 ? 'file' : 'files'}.`
          : `${label} is already clean.`;
    if (res.warnings.length > 0) {
      setFeedback({
        tone: 'warning',
        message: `${freedText} ${res.warnings.join(' ')}`,
      });
    } else {
      setFeedback({ tone: 'success', message: freedText });
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleClearCategory = (cat: CacheCategoryStats) => {
    if (busyKey) return;
    if (cat.blockedReason) {
      Alert.alert('Currently Protected', cat.blockedReason);
      return;
    }
    Alert.alert(
      `Clear ${cat.title}?`,
      `Remove ${formatBytes(cat.sizeBytes)} (${cat.fileCount} ${cat.fileCount === 1 ? 'file' : 'files'}) from local cache? Your NAS files and login session will remain untouched.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusyKey(cat.id);
              try {
                const res = await clearCategoryCache(cat.id, {
                  syncRunning: syncSnap.running,
                });
                applyCleanupOutcome(cat.title, res);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                Alert.alert('Could Not Clear Cache', msg);
              } finally {
                setBusyKey(null);
              }
            })();
          },
        },
      ],
    );
  };

  const handleClearAll = () => {
    if (!cacheSnap || busyKey) return;
    Alert.alert(
      'Clear All App Cache?',
      `Free up to ${formatBytes(cacheSnap.totalCacheBytes)} across ${cacheSnap.totalFileCount} cached files? Thumbnails and previews will re-download from your NAS on demand.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusyKey('all');
              try {
                const res = await clearAllCaches({
                  syncRunning: syncSnap.running,
                });
                applyCleanupOutcome('All app cache', res);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                Alert.alert('Clear Failed', msg);
              } finally {
                setBusyKey(null);
              }
            })();
          },
        },
      ],
    );
  };

  const handlePruneExpired = async () => {
    if (!cacheSnap || busyKey) return;
    setBusyKey('prune');
    try {
      const res = await pruneExpiredCacheNow({
        syncRunning: syncSnap.running,
        retentionDays: cacheSnap.settings.tempRetentionDays,
      });
      if (res.freedBytes === 0 && res.freedFiles === 0) {
        setCacheSnap(res.snapshot);
        setFeedback({
          tone: 'success',
          message: `No temporary files older than ${cacheSnap.settings.tempRetentionDays} days found.`,
        });
      } else {
        applyCleanupOutcome('Expired cache', res);
      }
    } catch (err) {
      setFeedback({
        tone: 'danger',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeleteDownloadFile = (item: CachedFileEntry) => {
    if (busyKey) return;
    Alert.alert(
      'Delete Cached Preview?',
      `Remove "${item.name}" (${formatBytes(item.sizeBytes)}) from local device cache?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusyKey(item.path);
              try {
                const res = await removeCachedDownloadItem(item.path, {
                  syncRunning: syncSnap.running,
                });
                applyCleanupOutcome(item.name, res);
              } catch (err) {
                Alert.alert('Delete Failed', err instanceof Error ? err.message : String(err));
              } finally {
                setBusyKey(null);
              }
            })();
          },
        },
      ],
    );
  };

  const handleUpdatePolicy = async (patch: Partial<CacheSettings>) => {
    try {
      const { settings, warnings } = await updateCachePolicy(patch);
      setCacheSnap((prev) => (prev ? { ...prev, settings } : prev));
      if (warnings.length > 0) {
        setFeedback({ tone: 'warning', message: warnings.join(' ') });
      }
      void Haptics.selectionAsync();
      await loadSnapshot();
    } catch (err) {
      Alert.alert('Update Failed', err instanceof Error ? err.message : String(err));
    }
  };

  if (loading && !cacheSnap) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.loadingText}>Analyzing local cache…</Text>
      </View>
    );
  }

  const snap = cacheSnap;
  const deviceUsedPercent =
    snap && snap.deviceTotalBytes > 0
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round(((snap.deviceTotalBytes - snap.deviceFreeBytes) / snap.deviceTotalBytes) * 100),
          ),
        )
      : 0;
  const nonZeroCategories = snap?.categories.filter((c) => c.sizeBytes > 0) ?? [];

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void loadSnapshot();
            }}
            tintColor={colors.accent}
          />
        }
      >
        {feedback ? (
          <Banner
            tone={feedback.tone}
            icon={
              feedback.tone === 'success'
                ? 'checkmark-circle-outline'
                : feedback.tone === 'warning'
                  ? 'alert-outline'
                  : 'alert-circle-outline'
            }
            message={feedback.message}
          />
        ) : null}

        {syncSnap.running ? (
          <Banner
            tone="warning"
            icon="sync-outline"
            title="Photo Backup Active"
            message="Sync staging temp files are locked while original photos are uploading to your NAS."
          />
        ) : null}

        {snap ? (
          <>
            <SectionTitle title="Cache Overview" />
            <Card style={styles.cardGap}>
              <View style={styles.heroHeader}>
                <View style={styles.flex}>
                  <Text style={styles.heroValue}>{formatBytes(snap.totalCacheBytes)}</Text>
                  <Text style={styles.heroSub}>
                    {snap.totalFileCount} {snap.totalFileCount === 1 ? 'cached file' : 'cached files'} · Updated{' '}
                    {formatDateTime(snap.inspectedAt)}
                  </Text>
                </View>
                <StatusBadge
                  tone={snap.totalCacheBytes === 0 ? 'success' : 'accent'}
                  label={
                    snap.totalCacheBytes === 0
                      ? 'Clean'
                      : `${snap.deviceUsedByCachePercent.toFixed(2)}% of disk`
                  }
                />
              </View>

              {snap.deviceTotalBytes > 0 ? (
                <View style={styles.deviceBarBox}>
                  <View style={styles.deviceBarLabels}>
                    <Text style={styles.deviceLabel}>iPhone Storage</Text>
                    <Text style={styles.deviceValue}>
                      {formatBytes(snap.deviceFreeBytes)} free of {formatBytes(snap.deviceTotalBytes)}
                    </Text>
                  </View>
                  <View style={styles.meterTrack}>
                    <View
                      style={[
                        styles.meterFill,
                        {
                          width: `${Math.max(3, deviceUsedPercent)}%`,
                          backgroundColor:
                            deviceUsedPercent >= 90
                              ? colors.danger
                              : deviceUsedPercent >= 78
                                ? colors.warning
                                : colors.accent,
                        },
                      ]}
                    />
                  </View>
                </View>
              ) : null}

              <View style={styles.metricsRow}>
                <View style={styles.metricBox}>
                  <Text style={styles.metricValue}>{snap.totalFileCount}</Text>
                  <Text style={styles.metricLabel}>Cached Files</Text>
                </View>
                <View style={styles.metricBox}>
                  <Text style={styles.metricValue}>
                    {snap.history.lastClearedAt
                      ? formatBytes(snap.history.lastClearedBytes)
                      : '—'}
                  </Text>
                  <Text style={styles.metricLabel}>Last Freed</Text>
                </View>
                <View style={[styles.metricBox, styles.metricHighlight]}>
                  <Text style={[styles.metricValue, { color: colors.accentDark }]}>
                    {formatBytes(snap.history.totalClearedBytes)}
                  </Text>
                  <Text style={styles.metricLabel}>
                    Total Freed ({snap.history.totalCleanRuns})
                  </Text>
                </View>
              </View>

              <View style={styles.heroActions}>
                <AppButton
                  title="Clear All Cache"
                  icon="trash-outline"
                  variant="danger"
                  compact
                  loading={busyKey === 'all'}
                  disabled={
                    busyKey !== null ||
                    (snap.totalCacheBytes === 0 && snap.totalFileCount === 0)
                  }
                  onPress={handleClearAll}
                  style={styles.flex}
                />
                <AppButton
                  title="Refresh"
                  icon="refresh-outline"
                  variant="subtle"
                  compact
                  disabled={busyKey !== null}
                  onPress={() => {
                    setRefreshing(true);
                    void loadSnapshot();
                  }}
                />
              </View>
            </Card>

            <SectionTitle title="Cache Breakdown" />
            <Card style={styles.cardGap}>
              {nonZeroCategories.length > 0 ? (
                <View style={styles.stackBar}>
                  {nonZeroCategories.map((cat) => (
                    <View
                      key={cat.id}
                      style={{
                        width: `${Math.max(3, cat.percentOfCache)}%`,
                        backgroundColor: cat.color,
                      }}
                    />
                  ))}
                </View>
              ) : (
                <Text style={styles.mutedText}>
                  All disposable cache categories are currently empty.
                </Text>
              )}

              <View style={styles.categoryList}>
                {snap.categories.map((cat, idx) => {
                  const isLast = idx === snap.categories.length - 1;
                  const isClearing = busyKey === cat.id;
                  const hasReclaimable =
                    cat.sizeBytes > 0 || cat.fileCount > 0 || cat.memoryBytes > 0;
                  return (
                    <View
                      key={cat.id}
                      style={[styles.categoryRow, !isLast && styles.rowDivider]}
                    >
                      <View
                        style={[
                          styles.categoryIconBox,
                          { backgroundColor: `${cat.color}18` },
                        ]}
                      >
                        <Ionicons
                          name={categoryIconName(cat.icon)}
                          size={19}
                          color={cat.color}
                        />
                      </View>
                      <View style={styles.flex}>
                        <View style={styles.categoryTitleRow}>
                          <View
                            style={[styles.dot, { backgroundColor: cat.color }]}
                          />
                          <Text style={styles.categoryTitle} numberOfLines={1}>
                            {cat.title}
                          </Text>
                        </View>
                        <Text style={styles.categorySub}>{cat.subtitle}</Text>
                        <Text style={styles.categoryStats}>
                          {formatBytes(cat.sizeBytes)} · {cat.fileCount}{' '}
                          {cat.fileCount === 1 ? 'file' : 'files'}
                          {snap.totalCacheBytes > 0 ? ` (${cat.percentOfCache}%)` : ''}
                          {cat.limitBytes != null
                            ? ` · Limit ${formatBytes(cat.limitBytes)}`
                            : ''}
                          {cat.memoryBytes > 0
                            ? ` · RAM ${formatBytes(cat.memoryBytes)}`
                            : ''}
                        </Text>
                        {cat.blockedReason ? (
                          <Text style={styles.blockedText}>{cat.blockedReason}</Text>
                        ) : null}
                      </View>
                      <Pressable
                        onPress={() => handleClearCategory(cat)}
                        disabled={
                          busyKey !== null ||
                          Boolean(cat.blockedReason) ||
                          !hasReclaimable
                        }
                        style={({ pressed }) => [
                          styles.clearPill,
                          (Boolean(cat.blockedReason) || !hasReclaimable) &&
                            styles.clearPillDisabled,
                          pressed && styles.clearPillPressed,
                        ]}
                      >
                        {isClearing ? (
                          <ActivityIndicator size="small" color={colors.accent} />
                        ) : (
                          <Text
                            style={[
                              styles.clearPillText,
                              (Boolean(cat.blockedReason) || !hasReclaimable) &&
                                styles.clearPillTextDisabled,
                            ]}
                          >
                            Clear
                          </Text>
                        )}
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            </Card>

            <SectionTitle title="Cache Policies & Limits" />
            <Card style={styles.cardGap}>
              <View style={styles.policyBlock}>
                <Text style={styles.policyLabel}>Image Disk Cache Limit</Text>
                <Text style={styles.policySub}>
                  Maximum disk space reserved for cached photo thumbnails & image previews
                </Text>
                <View style={styles.presetRow}>
                  {IMAGE_CACHE_LIMIT_PRESETS.map((preset) => {
                    const active =
                      snap.settings.imageMaxDiskSizeBytes === preset.bytes;
                    return (
                      <Pressable
                        key={preset.label}
                        onPress={() =>
                          void handleUpdatePolicy({
                            imageMaxDiskSizeBytes: preset.bytes,
                          })
                        }
                        style={[
                          styles.presetPill,
                          active && styles.presetPillActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.presetText,
                            active && styles.presetTextActive,
                          ]}
                        >
                          {preset.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <View style={[styles.policyBlock, styles.policyBorder]}>
                <Text style={styles.policyLabel}>Video Playback Cache Limit</Text>
                <Text style={styles.policySub}>
                  Least-recently-used disk cap for streamed NAS videos
                </Text>
                <View style={styles.presetRow}>
                  {VIDEO_CACHE_LIMIT_PRESETS.map((preset) => {
                    const active =
                      snap.settings.videoMaxCacheSizeBytes === preset.bytes;
                    return (
                      <Pressable
                        key={preset.label}
                        onPress={() =>
                          void handleUpdatePolicy({
                            videoMaxCacheSizeBytes: preset.bytes,
                          })
                        }
                        style={[
                          styles.presetPill,
                          active && styles.presetPillActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.presetText,
                            active && styles.presetTextActive,
                          ]}
                        >
                          {preset.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <View style={[styles.switchRow, styles.policyBorder]}>
                <View style={styles.flex}>
                  <Text style={styles.policyLabel}>Auto-Clean Expired Previews</Text>
                  <Text style={styles.policySub}>
                    Automatically delete temporary document previews & staging leftovers older than the retention window on launch
                  </Text>
                </View>
                <Switch
                  value={snap.settings.autoCleanExpiredTemp}
                  onValueChange={(value) =>
                    void handleUpdatePolicy({ autoCleanExpiredTemp: value })
                  }
                  trackColor={{ false: colors.lineStrong, true: colors.accent }}
                />
              </View>

              {snap.settings.autoCleanExpiredTemp ? (
                <View style={styles.policyBlock}>
                  <Text style={styles.policySub}>Retention window</Text>
                  <View style={styles.presetRow}>
                    {TEMP_RETENTION_DAY_PRESETS.map((days) => {
                      const active = snap.settings.tempRetentionDays === days;
                      return (
                        <Pressable
                          key={days}
                          onPress={() =>
                            void handleUpdatePolicy({ tempRetentionDays: days })
                          }
                          style={[
                            styles.presetPill,
                            active && styles.presetPillActive,
                          ]}
                        >
                          <Text
                            style={[
                              styles.presetText,
                              active && styles.presetTextActive,
                            ]}
                          >
                            {days} days
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : null}

              <AppButton
                title={`Clean Files Older Than ${snap.settings.tempRetentionDays} Days`}
                icon="sparkles-outline"
                variant="subtle"
                compact
                loading={busyKey === 'prune'}
                disabled={busyKey !== null}
                onPress={() => void handlePruneExpired()}
              />
            </Card>

            <SectionTitle
              title="Cached Previews & Downloads"
              right={
                snap.cachedDownloads.length > 0 ? (
                  <Text style={styles.sectionCount}>
                    {snap.cachedDownloads.length} shown
                  </Text>
                ) : undefined
              }
            />
            <Card style={styles.cardGap}>
              {snap.cachedDownloads.length === 0 ? (
                <Text style={styles.mutedText}>
                  No downloaded PDFs, Office previews, or shared files are currently cached locally.
                </Text>
              ) : (
                snap.cachedDownloads.map((item, idx) => {
                  const isLast = idx === snap.cachedDownloads.length - 1;
                  return (
                    <View
                      key={item.id}
                      style={[styles.fileRow, !isLast && styles.rowDivider]}
                    >
                      <View style={styles.fileIconWrap}>
                        <Ionicons
                          name="document-outline"
                          size={18}
                          color={colors.accent}
                        />
                      </View>
                      <View style={styles.flex}>
                        <Text style={styles.fileName} numberOfLines={1}>
                          {item.name}
                        </Text>
                        <Text style={styles.fileMeta}>
                          {formatBytes(item.sizeBytes)} ·{' '}
                          {formatDateTime(item.modifiedAtMs)}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => handleDeleteDownloadFile(item)}
                        disabled={busyKey !== null}
                        hitSlop={8}
                        style={styles.deleteIconBtn}
                      >
                        {busyKey === item.path ? (
                          <ActivityIndicator size="small" color={colors.danger} />
                        ) : (
                          <Ionicons
                            name="trash-outline"
                            size={17}
                            color={colors.danger}
                          />
                        )}
                      </Pressable>
                    </View>
                  );
                })
              )}
            </Card>

            <SectionTitle title="Preserved App Data" />
            <Card style={styles.cardGap}>
              <KeyValueRow
                label="Photo Sync Ledger DB"
                value={`${formatBytes(snap.syncDatabaseBytes)} (${ledgerStats.syncedCount + ledgerStats.dedupedCount} synced)`}
              />
              <KeyValueRow
                label="Active Account"
                value={user?.email ?? 'Signed in'}
                last={!snap.history.lastClearedAt}
              />
              {snap.history.lastClearedAt ? (
                <KeyValueRow
                  label="Last Cache Cleanup"
                  value={formatDateTime(snap.history.lastClearedAt)}
                  last
                />
              ) : null}
              <Text style={styles.mutedText}>
                Clearing cache never signs you out, resets your photo backup history, or deletes any files stored on your NAS.
              </Text>
            </Card>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
    minWidth: 0,
  },
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  loadingText: {
    fontSize: 14,
    color: colors.muted,
    fontWeight: '500',
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  cardGap: {
    gap: spacing.md,
  },
  heroHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  heroValue: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.5,
  },
  heroSub: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 2,
  },
  deviceBarBox: {
    gap: spacing.xs + 2,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  deviceBarLabels: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  deviceLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.ink,
  },
  deviceValue: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.muted,
  },
  meterTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surfaceSubtle,
    overflow: 'hidden',
  },
  meterFill: {
    height: '100%',
    borderRadius: 4,
  },
  metricsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  metricBox: {
    flex: 1,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.xs + 2,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
  },
  metricHighlight: {
    backgroundColor: colors.accentTint,
    borderColor: colors.accentBorder,
  },
  metricValue: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.ink,
    textAlign: 'center',
  },
  metricLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.muted,
    marginTop: 2,
    textAlign: 'center',
  },
  heroActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  stackBar: {
    flexDirection: 'row',
    height: 12,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: colors.surfaceSubtle,
    gap: 1,
  },
  categoryList: {
    gap: spacing.xs,
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  categoryIconBox: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  categoryTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  },
  categoryTitle: {
    fontSize: 14.5,
    fontWeight: '700',
    color: colors.ink,
    flexShrink: 1,
  },
  categorySub: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 2,
    lineHeight: 16,
  },
  categoryStats: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.inkSoft,
    marginTop: 3,
  },
  blockedText: {
    fontSize: 11.5,
    fontWeight: '600',
    color: colors.warning,
    marginTop: 2,
  },
  clearPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accentTint,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    minWidth: 58,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  clearPillPressed: {
    backgroundColor: '#d7ebe2',
  },
  clearPillDisabled: {
    backgroundColor: colors.surfaceSubtle,
    borderColor: colors.line,
  },
  clearPillText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.accentDark,
  },
  clearPillTextDisabled: {
    color: colors.muted,
  },
  policyBlock: {
    gap: spacing.xs + 2,
  },
  policyBorder: {
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  policyLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.ink,
  },
  policySub: {
    fontSize: 12,
    color: colors.muted,
    lineHeight: 16,
  },
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
    marginTop: 2,
  },
  presetPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.line,
  },
  presetPillActive: {
    backgroundColor: colors.accentTint,
    borderColor: colors.accent,
  },
  presetText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.inkSoft,
  },
  presetTextActive: {
    color: colors.accentDark,
    fontWeight: '700',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  sectionCount: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
  },
  fileIconWrap: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  fileName: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.ink,
  },
  fileMeta: {
    fontSize: 11.5,
    color: colors.muted,
    marginTop: 1,
  },
  deleteIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.dangerTint,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  mutedText: {
    fontSize: 12.5,
    color: colors.muted,
    lineHeight: 18,
  },
});
