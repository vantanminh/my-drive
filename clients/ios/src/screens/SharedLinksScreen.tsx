import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

import {
  ShareLinkModal,
  type ShareTargetSubject,
} from '../components/ShareLinkModal';
import {
  AppButton,
  Banner,
  Card,
  EmptyState,
  StatusBadge,
} from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import { formatShortDate } from '../services/format';
import {
  forgetRememberedShareUrls,
  loadRememberedShareUrls,
} from '../services/secureStorage';
import {
  classifyShareStatus,
  filterAndSortShares,
  formatExpiryCountdown,
  isShareActive,
  type ShareFilterKey,
  type ShareSortKey,
} from '../services/shareLinks';
import { colors, radius, spacing } from '../theme/tokens';
import type { ShareSummary, UpdateShareInput } from '../types/mydrive';

const FILTER_OPTIONS: Array<{ key: ShareFilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'expiring_soon', label: 'Expiring Soon' },
  { key: 'protected', label: 'Protected' },
  { key: 'inactive', label: 'Inactive' },
];

const SORT_CYCLE: Array<{ key: ShareSortKey; label: string }> = [
  { key: 'newest', label: 'Newest' },
  { key: 'most_downloaded', label: 'Most Downloads' },
  { key: 'expiring_soon', label: 'Expiring Soon' },
  { key: 'last_accessed', label: 'Last Accessed' },
];

type EditExpiryMode = 'keep' | '1d' | '7d' | '30d' | 'never';
type EditLimitMode = 'unlimited' | '1' | '5' | '20' | '50';
type EditPasswordMode = 'keep' | 'set' | 'remove';

function statusBadgeMeta(share: ShareSummary): {
  label: string;
  tone: 'accent' | 'neutral' | 'success' | 'warning' | 'danger';
} {
  const status = classifyShareStatus(share);
  switch (status) {
    case 'active':
      return {
        label: share.expires_at ? formatExpiryCountdown(share.expires_at) : 'Active',
        tone: 'success',
      };
    case 'expiring_soon':
      return {
        label: formatExpiryCountdown(share.expires_at),
        tone: 'warning',
      };
    case 'revoked':
      return { label: 'Revoked', tone: 'danger' };
    case 'expired':
      return { label: 'Expired', tone: 'neutral' };
    case 'exhausted':
      return { label: 'Limit Reached', tone: 'warning' };
  }
}

function resourceIconName(
  resourceType: ShareSummary['resource_type'],
): keyof typeof Ionicons.glyphMap {
  if (resourceType === 'folder') return 'folder-outline';
  if (resourceType === 'album') return 'albums-outline';
  return 'document-outline';
}

export function SharedLinksScreen() {
  const { client, serverUrl } = useAuth();
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [cachedUrls, setCachedUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ShareFilterKey>('all');
  const [sortIndex, setSortIndex] = useState(0);
  const [cleaningUp, setCleaningUp] = useState(false);

  const [shareSubject, setShareSubject] = useState<ShareTargetSubject | null>(null);

  // Edit rule modal state
  const [editTarget, setEditTarget] = useState<ShareSummary | null>(null);
  const [editExpiry, setEditExpiry] = useState<EditExpiryMode>('keep');
  const [editAllowDownload, setEditAllowDownload] = useState(true);
  const [editLimit, setEditLimit] = useState<EditLimitMode>('unlimited');
  const [editPasswordMode, setEditPasswordMode] = useState<EditPasswordMode>('keep');
  const [editPasswordText, setEditPasswordText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const activeSort = SORT_CYCLE[sortIndex].key;

  const refreshCachedUrls = useCallback(async () => {
    if (!serverUrl) return;
    const map = await loadRememberedShareUrls(serverUrl);
    setCachedUrls(map);
  }, [serverUrl]);

  const loadShares = useCallback(
    async (offset = 0, replace = true) => {
      if (!client) return;
      if (replace) {
        setErrorMsg(null);
      }
      try {
        const res = await client.listShares(offset, 50);
        setShares((prev) => (replace ? res.shares : [...prev, ...res.shares]));
        setNextOffset(res.next_offset);
        await refreshCachedUrls();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    },
    [client, refreshCachedUrls],
  );

  useEffect(() => {
    void loadShares(0, true);
  }, [loadShares]);

  const stats = useMemo(() => {
    let active = 0;
    let expiringSoon = 0;
    let protectedCount = 0;
    let totalDownloads = 0;
    let inactiveCount = 0;
    for (const share of shares) {
      totalDownloads += share.download_count;
      const status = classifyShareStatus(share);
      if (status === 'active') active += 1;
      if (status === 'expiring_soon') {
        active += 1;
        expiringSoon += 1;
      }
      if (status === 'expired' || status === 'revoked' || status === 'exhausted') {
        inactiveCount += 1;
      }
      if (share.password_protected && isShareActive(share)) {
        protectedCount += 1;
      }
    }
    return { active, expiringSoon, protectedCount, totalDownloads, inactiveCount };
  }, [shares]);

  const visibleShares = useMemo(
    () =>
      filterAndSortShares(shares, {
        query,
        filter,
        sort: activeSort,
      }),
    [shares, query, filter, activeSort],
  );

  const openEditModal = (share: ShareSummary) => {
    setEditTarget(share);
    setEditExpiry('keep');
    setEditAllowDownload(share.allow_download);
    if (
      share.max_downloads === 1 ||
      share.max_downloads === 5 ||
      share.max_downloads === 20 ||
      share.max_downloads === 50
    ) {
      setEditLimit(String(share.max_downloads) as EditLimitMode);
    } else {
      setEditLimit('unlimited');
    }
    setEditPasswordMode('keep');
    setEditPasswordText('');
  };

  const handleSaveEdit = async () => {
    if (!client || !editTarget) return;
    if (editPasswordMode === 'set' && editPasswordText.trim().length < 4) {
      Alert.alert('Password Too Short', 'Enter at least 4 characters for the link password.');
      return;
    }

    const payload: UpdateShareInput = {
      allow_download: editAllowDownload,
      max_downloads: editLimit === 'unlimited' ? null : Number(editLimit),
    };

    if (editExpiry !== 'keep') {
      if (editExpiry === 'never') {
        payload.expires_at = null;
      } else {
        const hours = editExpiry === '1d' ? 24 : editExpiry === '7d' ? 24 * 7 : 24 * 30;
        payload.expires_at = new Date(Date.now() + hours * 3600 * 1000).toISOString();
      }
    }

    if (editPasswordMode === 'set') {
      payload.password = editPasswordText.trim();
    } else if (editPasswordMode === 'remove') {
      payload.password = null;
    }

    setSavingEdit(true);
    try {
      const updated = await client.updateShare(editTarget.id, payload);
      setShares((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setEditTarget(null);
    } catch (err) {
      Alert.alert('Update Failed', err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleRevoke = (share: ShareSummary) => {
    if (!client) return;
    Alert.alert(
      'Revoke Share Link',
      `Anyone holding the link for "${share.resource_name}" will lose access immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke Link',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await client.revokeShare(share.id);
                setShares((prev) =>
                  prev.map((item) =>
                    item.id === share.id
                      ? { ...item, revoked_at: new Date().toISOString() }
                      : item,
                  ),
                );
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              } catch (err) {
                Alert.alert('Revoke Failed', err instanceof Error ? err.message : String(err));
              }
            })();
          },
        },
      ],
    );
  };

  const handleDelete = (share: ShareSummary) => {
    if (!client) return;
    Alert.alert(
      'Delete Share Record',
      `Remove "${share.resource_name}" from your share history?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await client.deleteShare(share.id);
                setShares((prev) => prev.filter((item) => item.id !== share.id));
                if (serverUrl) {
                  await forgetRememberedShareUrls(serverUrl, [share.id]);
                  await refreshCachedUrls();
                }
              } catch (err) {
                Alert.alert('Delete Failed', err instanceof Error ? err.message : String(err));
              }
            })();
          },
        },
      ],
    );
  };

  const handleCleanupInactive = () => {
    if (!client || stats.inactiveCount === 0) return;
    Alert.alert(
      'Clean Up Inactive Links',
      `Delete ${stats.inactiveCount} expired, revoked, or exhausted share record${stats.inactiveCount === 1 ? '' : 's'} from your history?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clean Up',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setCleaningUp(true);
              try {
                const inactiveIds = shares
                  .filter((item) => !isShareActive(item))
                  .map((item) => item.id);
                const result = await client.cleanupShares();
                if (serverUrl && inactiveIds.length > 0) {
                  await forgetRememberedShareUrls(serverUrl, inactiveIds);
                }
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                await loadShares(0, true);
                Alert.alert(
                  'History Cleaned',
                  `Removed ${result.deleted} inactive share link${result.deleted === 1 ? '' : 's'}.`,
                );
              } catch (err) {
                Alert.alert('Cleanup Failed', err instanceof Error ? err.message : String(err));
              } finally {
                setCleaningUp(false);
              }
            })();
          },
        },
      ],
    );
  };

  const handleShareCachedUrl = async (share: ShareSummary, url: string) => {
    try {
      await Share.share({
        title: share.resource_name,
        message: `${share.resource_name}\n${url}`,
        url,
      });
    } catch {
      // User dismissed share sheet.
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
            Shared Links
          </Text>
          <Text style={styles.subtitle} numberOfLines={2}>
            Manage active URLs, expiry & permissions
          </Text>
        </View>
        {stats.inactiveCount > 0 ? (
          <AppButton
            title={`Clean (${stats.inactiveCount})`}
            icon="sparkles-outline"
            variant="secondary"
            compact
            loading={cleaningUp}
            onPress={handleCleanupInactive}
          />
        ) : (
          <Pressable
            onPress={() => setSortIndex((idx) => (idx + 1) % SORT_CYCLE.length)}
            style={({ pressed }) => [styles.sortPill, pressed && { opacity: 0.75 }]}
          >
            <Ionicons name="swap-vertical" size={14} color={colors.accent} />
            <Text style={styles.sortPillText}>{SORT_CYCLE[sortIndex].label}</Text>
          </Pressable>
        )}
      </View>

      {errorMsg ? (
        <View style={styles.bannerWrap}>
          <Banner tone="danger" icon="alert-circle-outline" message={errorMsg} />
        </View>
      ) : null}

      <FlatList
        data={visibleShares}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void loadShares(0, true);
            }}
            tintColor={colors.accent}
          />
        }
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (nextOffset != null && !loadingMore && !loading) {
            setLoadingMore(true);
            void loadShares(nextOffset, false);
          }
        }}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <View style={styles.kpiGrid}>
              <View style={styles.kpiTile}>
                <Text style={styles.kpiValue}>{stats.active}</Text>
                <Text style={styles.kpiLabel}>Active</Text>
              </View>
              <View style={styles.kpiTile}>
                <Text
                  style={[
                    styles.kpiValue,
                    stats.expiringSoon > 0 && { color: colors.warning },
                  ]}
                >
                  {stats.expiringSoon}
                </Text>
                <Text style={styles.kpiLabel}>&lt;24h Left</Text>
              </View>
              <View style={styles.kpiTile}>
                <Text style={styles.kpiValue}>{stats.protectedCount}</Text>
                <Text style={styles.kpiLabel}>Protected</Text>
              </View>
              <View style={styles.kpiTile}>
                <Text style={styles.kpiValue}>{stats.totalDownloads}</Text>
                <Text style={styles.kpiLabel}>Downloads</Text>
              </View>
            </View>

            <View style={styles.searchBox}>
              <Ionicons name="search-outline" size={17} color={colors.muted} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search shared files, folders, albums…"
                placeholderTextColor={colors.muted}
                value={query}
                onChangeText={setQuery}
                returnKeyType="search"
              />
              {query.length > 0 ? (
                <Pressable onPress={() => setQuery('')} hitSlop={8}>
                  <Ionicons name="close-circle" size={18} color={colors.muted} />
                </Pressable>
              ) : null}
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterRow}
            >
              {FILTER_OPTIONS.map((opt) => {
                const selected = filter === opt.key;
                return (
                  <Pressable
                    key={opt.key}
                    onPress={() => setFilter(opt.key)}
                    style={[styles.filterChip, selected && styles.filterChipSelected]}
                  >
                    <Text
                      style={[
                        styles.filterChipText,
                        selected && styles.filterChipTextSelected,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
              {stats.inactiveCount > 0 ? (
                <Pressable
                  onPress={() => setSortIndex((idx) => (idx + 1) % SORT_CYCLE.length)}
                  style={styles.filterChip}
                >
                  <Text style={styles.filterChipText}>Sort: {SORT_CYCLE[sortIndex].label}</Text>
                </Pressable>
              ) : null}
            </ScrollView>
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color={colors.accent} />
            </View>
          ) : (
            <EmptyState
              icon="link-outline"
              title={query || filter !== 'all' ? 'No Matching Links' : 'No Shared Links Yet'}
              message={
                query || filter !== 'all'
                  ? 'Try clearing your search or switching the status filter.'
                  : 'Tap Share Public Link on any file, folder, photo, or album to create your first link.'
              }
            />
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footerLoader}>
              <ActivityIndicator size="small" color={colors.accent} />
            </View>
          ) : undefined
        }
        renderItem={({ item }) => {
          const active = isShareActive(item);
          const badge = statusBadgeMeta(item);
          const cachedUrl = cachedUrls[item.id];
          return (
            <Card style={styles.shareCard}>
              <View style={styles.cardTop}>
                <View style={styles.resourceIconWrap}>
                  <Ionicons
                    name={resourceIconName(item.resource_type)}
                    size={20}
                    color={colors.accent}
                  />
                </View>
                <View style={styles.cardMeta}>
                  <Text style={styles.resourceName} numberOfLines={1}>
                    {item.resource_name}
                  </Text>
                  <Text style={styles.resourceSub}>
                    {item.resource_type.toUpperCase()} · Created {formatShortDate(item.created_at)}
                  </Text>
                </View>
                <StatusBadge label={badge.label} tone={badge.tone} />
              </View>

              <View style={styles.badgesRow}>
                <StatusBadge
                  label={
                    item.max_downloads != null
                      ? `${item.download_count}/${item.max_downloads} downloads`
                      : `${item.download_count} download${item.download_count === 1 ? '' : 's'}`
                  }
                  tone="neutral"
                />
                {item.password_protected ? (
                  <StatusBadge label="Password" tone="accent" />
                ) : null}
                {!item.allow_download ? (
                  <StatusBadge label="View Only" tone="warning" />
                ) : null}
                {item.last_accessed_at ? (
                  <StatusBadge
                    label={`Opened ${formatShortDate(item.last_accessed_at)}`}
                    tone="neutral"
                  />
                ) : null}
              </View>

              {cachedUrl && active ? (
                <View style={styles.cachedUrlBox}>
                  <Text style={styles.cachedUrlText} selectable numberOfLines={1}>
                    {cachedUrl}
                  </Text>
                  <Pressable
                    onPress={() => void handleShareCachedUrl(item, cachedUrl)}
                    hitSlop={8}
                    style={styles.inlineIconBtn}
                  >
                    <Ionicons name="share-outline" size={17} color={colors.accent} />
                  </Pressable>
                  <Pressable
                    onPress={() => void Linking.openURL(cachedUrl)}
                    hitSlop={8}
                    style={styles.inlineIconBtn}
                  >
                    <Ionicons name="open-outline" size={17} color={colors.accent} />
                  </Pressable>
                </View>
              ) : null}

              <View style={styles.cardActions}>
                {active ? (
                  <>
                    <AppButton
                      title="Edit Rules"
                      icon="options-outline"
                      variant="secondary"
                      compact
                      style={styles.actionBtn}
                      onPress={() => openEditModal(item)}
                    />
                    <AppButton
                      title={cachedUrl ? 'Re-share' : 'New Link'}
                      icon={cachedUrl ? 'share-social-outline' : 'add-circle-outline'}
                      variant="subtle"
                      compact
                      style={styles.actionBtn}
                      onPress={() => {
                        if (cachedUrl) {
                          void handleShareCachedUrl(item, cachedUrl);
                        } else {
                          setShareSubject({
                            resourceType: item.resource_type,
                            resourceId: item.resource_id,
                            name: item.resource_name,
                          });
                        }
                      }}
                    />
                    <Pressable
                      onPress={() => handleRevoke(item)}
                      style={styles.dangerIconBtn}
                      hitSlop={6}
                    >
                      <Ionicons name="ban-outline" size={18} color={colors.danger} />
                    </Pressable>
                  </>
                ) : (
                  <>
                    <AppButton
                      title="Fresh Link"
                      icon="refresh-outline"
                      variant="secondary"
                      compact
                      style={styles.actionBtn}
                      onPress={() =>
                        setShareSubject({
                          resourceType: item.resource_type,
                          resourceId: item.resource_id,
                          name: item.resource_name,
                        })
                      }
                    />
                    <AppButton
                      title="Delete"
                      icon="trash-outline"
                      variant="danger"
                      compact
                      style={styles.actionBtn}
                      onPress={() => handleDelete(item)}
                    />
                  </>
                )}
              </View>
            </Card>
          );
        }}
      />

      <ShareLinkModal
        visible={Boolean(shareSubject)}
        subject={shareSubject}
        onClose={() => setShareSubject(null)}
        onCreated={() => {
          void loadShares(0, true);
        }}
      />

      <Modal
        visible={Boolean(editTarget)}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!savingEdit) setEditTarget(null);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalBackdrop}
        >
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle} numberOfLines={1}>
                Edit Share Rules
              </Text>
              <Pressable onPress={() => !savingEdit && setEditTarget(null)} hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.muted} />
              </Pressable>
            </View>
            {editTarget ? (
              <Text style={styles.modalSubtitle} numberOfLines={1}>
                {editTarget.resource_name} — URL stays unchanged
              </Text>
            ) : null}

            <ScrollView style={styles.modalBody} showsVerticalScrollIndicator={false}>
              <Text style={styles.fieldLabel}>Expiration</Text>
              <View style={styles.chipWrap}>
                {(
                  [
                    { key: 'keep', label: 'Keep' },
                    { key: '1d', label: '+24h' },
                    { key: '7d', label: '+7d' },
                    { key: '30d', label: '+30d' },
                    { key: 'never', label: 'Never' },
                  ] as const
                ).map((opt) => (
                  <Pressable
                    key={opt.key}
                    onPress={() => setEditExpiry(opt.key)}
                    style={[
                      styles.choiceChip,
                      editExpiry === opt.key && styles.choiceChipActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        editExpiry === opt.key && styles.choiceChipTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <View style={styles.switchRow}>
                <View style={styles.switchInfo}>
                  <Text style={styles.fieldLabel}>Allow Downloads</Text>
                  <Text style={styles.fieldHint}>
                    Turn off for view-only streaming/previews
                  </Text>
                </View>
                <Switch
                  value={editAllowDownload}
                  onValueChange={setEditAllowDownload}
                  trackColor={{ true: colors.accent }}
                />
              </View>

              <Text style={styles.fieldLabel}>Download Cap</Text>
              <View style={styles.chipWrap}>
                {(['unlimited', '1', '5', '20', '50'] as const).map((opt) => (
                  <Pressable
                    key={opt}
                    onPress={() => setEditLimit(opt)}
                    style={[styles.choiceChip, editLimit === opt && styles.choiceChipActive]}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        editLimit === opt && styles.choiceChipTextActive,
                      ]}
                    >
                      {opt === 'unlimited' ? 'Unlimited' : opt}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.fieldLabel}>Password</Text>
              <View style={styles.chipWrap}>
                {(
                  [
                    { key: 'keep', label: 'Keep Existing' },
                    { key: 'set', label: 'Set New' },
                    ...(editTarget?.password_protected
                      ? [{ key: 'remove', label: 'Remove' } as const]
                      : []),
                  ] as const
                ).map((opt) => (
                  <Pressable
                    key={opt.key}
                    onPress={() => setEditPasswordMode(opt.key)}
                    style={[
                      styles.choiceChip,
                      editPasswordMode === opt.key && styles.choiceChipActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        editPasswordMode === opt.key && styles.choiceChipTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {editPasswordMode === 'set' ? (
                <TextInput
                  style={styles.passwordInput}
                  placeholder="Minimum 4 characters"
                  placeholderTextColor={colors.muted}
                  secureTextEntry
                  autoCapitalize="none"
                  value={editPasswordText}
                  onChangeText={setEditPasswordText}
                />
              ) : null}
            </ScrollView>

            <View style={styles.modalFooter}>
              <AppButton
                title="Cancel"
                variant="secondary"
                onPress={() => setEditTarget(null)}
                disabled={savingEdit}
                style={styles.modalFooterBtn}
              />
              <AppButton
                title="Save Rules"
                onPress={() => void handleSaveEdit()}
                loading={savingEdit}
                style={styles.modalFooterBtn}
              />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.ink,
  },
  subtitle: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 2,
  },
  sortPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.accentTint,
    borderWidth: 1,
    borderColor: colors.accentBorder,
  },
  sortPillText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.accentDark,
  },
  bannerWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  listContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    gap: spacing.md,
  },
  listHeader: {
    gap: spacing.md,
    marginBottom: spacing.xs,
  },
  kpiGrid: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  kpiTile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  kpiValue: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.ink,
  },
  kpiLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.muted,
    marginTop: 2,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    minHeight: 42,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: colors.ink,
    paddingVertical: spacing.xs,
  },
  filterRow: {
    gap: spacing.xs,
    paddingRight: spacing.sm,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  filterChipSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  filterChipText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.inkSoft,
  },
  filterChipTextSelected: {
    color: colors.white,
  },
  center: {
    paddingVertical: spacing.xxxl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerLoader: {
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  shareCard: {
    gap: spacing.sm,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  resourceIconWrap: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardMeta: {
    flex: 1,
  },
  resourceName: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
  },
  resourceSub: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 2,
  },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  cachedUrlBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    gap: spacing.xs,
  },
  cachedUrlText: {
    flex: 1,
    fontSize: 12,
    color: colors.inkSoft,
  },
  inlineIconBtn: {
    padding: 4,
  },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 2,
  },
  actionBtn: {
    flex: 1,
  },
  dangerIconBtn: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 25, 35, 0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.xl,
    maxHeight: '85%',
    gap: spacing.sm,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.ink,
  },
  modalSubtitle: {
    fontSize: 12.5,
    color: colors.muted,
  },
  modalBody: {
    marginTop: spacing.xs,
  },
  fieldLabel: {
    fontSize: 13.5,
    fontWeight: '700',
    color: colors.ink,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  fieldHint: {
    fontSize: 12,
    color: colors.muted,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  choiceChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surfaceSubtle,
  },
  choiceChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  choiceChipText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.inkSoft,
  },
  choiceChipTextActive: {
    color: colors.white,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  switchInfo: {
    flex: 1,
    paddingRight: spacing.md,
  },
  passwordInput: {
    marginTop: spacing.sm,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: 14,
    color: colors.ink,
  },
  modalFooter: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  modalFooterBtn: {
    flex: 1,
  },
});
