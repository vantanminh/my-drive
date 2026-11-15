import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

import { AppButton, Banner, EmptyState } from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import { formatBytes, formatShortDate } from '../services/format';
import { colors, radius, spacing } from '../theme/tokens';
import type { Entry } from '../types/mydrive';

export function TrashScreen() {
  const { client } = useAuth();
  const [items, setItems] = useState<Entry[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAll, setBusyAll] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadTrash = useCallback(
    async (offset = 0, replace = false) => {
      if (!client) return;
      if (replace) setErrorMsg(null);
      try {
        const page = await client.listTrash(offset, 100);
        setItems((prev) => (replace ? page.entries : [...prev, ...page.entries]));
        setNextOffset(page.next_offset);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void loadTrash(0, true);
  }, [loadTrash]);

  const totalVisibleBytes = useMemo(
    () =>
      items.reduce(
        (sum, item) => sum + (item.folder_bytes ?? item.size_bytes ?? 0),
        0,
      ),
    [items],
  );

  const handleRestore = async (entry: Entry) => {
    if (!client) return;
    try {
      await client.restoreEntry(entry.id);
      setItems((prev) => prev.filter((item) => item.id !== entry.id));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      Alert.alert('Restore Failed', err instanceof Error ? err.message : String(err));
    }
  };

  const handlePurgeOne = (entry: Entry) => {
    if (!client) return;
    Alert.alert(
      'Delete Permanently?',
      `"${entry.name}" will be permanently removed from your NAS disk and cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Forever',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await client.purgeTrash({ ids: [entry.id] });
                setItems((prev) => prev.filter((item) => item.id !== entry.id));
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              } catch (err) {
                Alert.alert('Purge Failed', err instanceof Error ? err.message : String(err));
              }
            })();
          },
        },
      ],
    );
  };

  const handleEmptyTrash = () => {
    if (!client || items.length === 0 || busyAll) return;
    Alert.alert(
      'Empty Trash Forever?',
      `Permanently delete all ${items.length}+ items (${formatBytes(totalVisibleBytes)}) to immediately reclaim NAS disk space?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Empty Trash',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusyAll(true);
              try {
                await client.purgeTrash({ all: true });
                setItems([]);
                setNextOffset(null);
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              } catch (err) {
                Alert.alert('Empty Trash Failed', err instanceof Error ? err.message : String(err));
              } finally {
                setBusyAll(false);
              }
            })();
          },
        },
      ],
    );
  };

  if (loading && items.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {items.length > 0 ? (
        <View style={styles.topBar}>
          <Text style={styles.summaryText} numberOfLines={2}>
            {items.length} {items.length === 1 ? 'item' : 'items'} • {formatBytes(totalVisibleBytes)} recoverable
          </Text>
          <AppButton
            title="Empty Trash"
            icon="trash-outline"
            variant="danger"
            compact
            loading={busyAll}
            onPress={handleEmptyTrash}
          />
        </View>
      ) : null}

      {errorMsg ? (
        <View style={styles.bannerWrap}>
          <Banner tone="danger" icon="alert-circle-outline" message={errorMsg} />
        </View>
      ) : null}

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={
          items.length === 0 ? styles.emptyContainer : styles.listContent
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void loadTrash(0, true);
            }}
            tintColor={colors.accent}
          />
        }
        onEndReached={() => {
          if (nextOffset != null && !loading) {
            setLoading(true);
            void loadTrash(nextOffset, false);
          }
        }}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          <EmptyState
            icon="trash-bin-outline"
            title="Trash Is Empty"
            message="Files and folders you delete appear here before being permanently purged from your NAS."
          />
        }
        renderItem={({ item }) => (
          <View style={styles.rowCard}>
            <View style={styles.iconBox}>
              <Ionicons
                name={item.kind === 'folder' ? 'folder-outline' : 'document-outline'}
                size={21}
                color={colors.muted}
              />
            </View>
            <View style={styles.flex}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.meta}>
                {formatBytes(item.folder_bytes ?? item.size_bytes)} • Deleted {formatShortDate(item.deleted_at ?? item.updated_at)}
              </Text>
            </View>
            <Pressable
              onPress={() => void handleRestore(item)}
              hitSlop={8}
              style={styles.actionIconBtn}
            >
              <Ionicons name="refresh-outline" size={19} color={colors.accent} />
            </Pressable>
            <Pressable
              onPress={() => handlePurgeOne(item)}
              hitSlop={8}
              style={styles.actionIconBtn}
            >
              <Ionicons name="close-circle-outline" size={19} color={colors.danger} />
            </Pressable>
          </View>
        )}
      />
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
  },
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  summaryText: {
    flex: 1,
    minWidth: 0,
    fontSize: 13.5,
    fontWeight: '700',
    color: colors.inkSoft,
  },
  bannerWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  emptyContainer: {
    flexGrow: 1,
  },
  listContent: {
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.xxxl,
  },
  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    fontSize: 14.5,
    fontWeight: '600',
    color: colors.ink,
  },
  meta: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 2,
  },
  actionIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surfaceSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
