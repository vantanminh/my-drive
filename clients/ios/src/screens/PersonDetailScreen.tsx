import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

import { MediaGrid } from '../components/MediaGrid';
import { TextPromptModal } from '../components/TextPromptModal';
import { Banner, EmptyState } from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import { colors, radius, spacing } from '../theme/tokens';
import type { FaceCluster, MediaItem } from '../types/mydrive';

type Props = NativeStackScreenProps<RootStackParamList, 'PersonDetail'>;

export function PersonDetailScreen({ navigation, route }: Props) {
  const { client } = useAuth();
  const [cluster, setCluster] = useState<FaceCluster>(route.params.cluster);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);

  const displayName = cluster.label?.trim() || 'Unnamed Person';

  useEffect(() => {
    navigation.setOptions({
      title: displayName,
    });
  }, [navigation, displayName]);

  const loadMedia = useCallback(
    async (offset = 0, replace = false) => {
      if (!client) return;
      if (replace) setErrorMsg(null);
      try {
        const [freshCluster, page] = await Promise.all([
          replace ? client.getFaceCluster(cluster.id) : Promise.resolve(cluster),
          client.listFaceMedia(cluster.id, offset, 80),
        ]);
        if (replace) {
          setCluster(freshCluster);
        }
        setItems((prev) => (replace ? page.items : [...prev, ...page.items]));
        setNextOffset(page.next_offset ?? null);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [client, cluster.id],
  );

  useEffect(() => {
    void loadMedia(0, true);
  }, [loadMedia]);

  const handleRename = async (newName: string) => {
    if (!client) return;
    const trimmed = newName.trim();
    const updated = await client.renameFaceCluster(cluster.id, trimmed || null);
    setCluster((prev) => ({ ...prev, label: updated.label }));
    setRenameOpen(false);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleClearLabel = () => {
    if (!client || !cluster.label) return;
    Alert.alert('Clear Name', `Remove "${cluster.label}" from this person?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear Name',
        onPress: () => {
          void (async () => {
            try {
              const updated = await client.renameFaceCluster(cluster.id, null);
              setCluster((prev) => ({ ...prev, label: updated.label }));
            } catch (err) {
              Alert.alert('Rename Failed', err instanceof Error ? err.message : String(err));
            }
          })();
        },
      },
    ]);
  };

  const avatarSource = cluster.representativeFileId
    ? client?.thumbnailSource(cluster.representativeFileId)
    : null;

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <View style={styles.avatarWrap}>
          {avatarSource ? (
            <Image
              source={avatarSource}
              style={styles.avatar}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Ionicons name="person-outline" size={28} color={colors.accent} />
            </View>
          )}
        </View>
        <View style={styles.heroInfo}>
          <Text style={styles.heroName} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={styles.heroMeta}>
            {cluster.assetCount} {cluster.assetCount === 1 ? 'photo' : 'photos'} ·{' '}
            {cluster.faceCount} {cluster.faceCount === 1 ? 'appearance' : 'appearances'}
          </Text>
        </View>
        <Pressable
          onPress={() => setRenameOpen(true)}
          style={({ pressed }) => [styles.renameBtn, pressed && { opacity: 0.75 }]}
        >
          <Ionicons name="pencil-outline" size={16} color={colors.accent} />
          <Text style={styles.renameBtnText}>Name</Text>
        </Pressable>
        {cluster.label ? (
          <Pressable
            onPress={handleClearLabel}
            hitSlop={8}
            style={styles.clearBtn}
          >
            <Ionicons name="close-outline" size={18} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>

      {errorMsg ? (
        <View style={styles.banner}>
          <Banner tone="danger" icon="alert-circle-outline" message={errorMsg} />
        </View>
      ) : null}

      {loading && items.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : (
        <MediaGrid
          items={items}
          loading={loading}
          refreshing={refreshing}
          hasMore={nextOffset != null}
          onRefresh={() => {
            setRefreshing(true);
            void loadMedia(0, true);
          }}
          onLoadMore={() => {
            if (nextOffset != null) {
              setLoading(true);
              void loadMedia(nextOffset, false);
            }
          }}
          onPressItem={(_item, index) => {
            navigation.navigate('PhotoViewer', {
              items,
              initialIndex: index,
              title: displayName,
            });
          }}
          ListEmptyComponent={
            <EmptyState
              icon="people-outline"
              title="No Photos Found"
              message="No media entries are currently linked to this person."
            />
          }
        />
      )}

      <TextPromptModal
        visible={renameOpen}
        title="Name Person"
        initialValue={cluster.label ?? ''}
        placeholder="Mom, Alex, Linh…"
        confirmLabel="Save"
        onCancel={() => setRenameOpen(false)}
        onSubmit={handleRename}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  avatarWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.line,
  },
  avatar: {
    width: '100%',
    height: '100%',
  },
  avatarPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentTint,
  },
  heroInfo: {
    flex: 1,
    minWidth: 0,
  },
  heroName: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.ink,
  },
  heroMeta: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 2,
  },
  renameBtn: {
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
  renameBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.accentDark,
  },
  clearBtn: {
    padding: 4,
  },
  banner: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
