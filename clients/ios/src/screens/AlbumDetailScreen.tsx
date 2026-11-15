import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';

import { MediaGrid } from '../components/MediaGrid';
import { ShareLinkModal } from '../components/ShareLinkModal';
import { Banner, EmptyState } from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import { colors, spacing } from '../theme/tokens';
import type { MediaItem } from '../types/mydrive';

type Props = NativeStackScreenProps<RootStackParamList, 'AlbumDetail'>;

export function AlbumDetailScreen({ navigation, route }: Props) {
  const { album } = route.params;
  const { client } = useAuth();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => {
    navigation.setOptions({
      title: album.name,
      headerRight: () => (
        <Pressable
          onPress={() => setShareOpen(true)}
          hitSlop={8}
          style={{ paddingHorizontal: 4 }}
        >
          <Ionicons name="share-outline" size={22} color={colors.accent} />
        </Pressable>
      ),
    });
  }, [navigation, album.name]);

  const loadItems = useCallback(
    async (offset = 0, replace = false) => {
      if (!client) return;
      if (replace) setErrorMsg(null);
      try {
        const page = await client.listAlbumItems(album.id, offset, 60);
        setItems((prev) => (replace ? page.items : [...prev, ...page.items]));
        setNextOffset(page.next_offset);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [client, album.id],
  );

  useEffect(() => {
    void loadItems(0, true);
  }, [loadItems]);

  return (
    <View style={styles.container}>
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
            void loadItems(0, true);
          }}
          onLoadMore={() => {
            if (nextOffset != null) {
              setLoading(true);
              void loadItems(nextOffset, false);
            }
          }}
          onPressItem={(_item, index) => {
            navigation.navigate('PhotoViewer', {
              items,
              initialIndex: index,
              title: album.name,
            });
          }}
          ListEmptyComponent={
            <EmptyState
              icon="images-outline"
              title="Empty Album"
              message="Open any photo in Timeline and tap Add to Album to organize items here."
            />
          }
        />
      )}

      <ShareLinkModal
        visible={shareOpen}
        subject={{
          resourceType: 'album',
          resourceId: album.id,
          name: album.name,
        }}
        onClose={() => setShareOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  banner: {
    padding: spacing.lg,
  },
});
