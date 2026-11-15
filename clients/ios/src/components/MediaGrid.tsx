import React from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../context/AuthContext';
import { formatDuration } from '../services/format';
import { colors, radius, spacing } from '../theme/tokens';
import type { MediaItem } from '../types/mydrive';

const COLUMNS = 3;
const GAP = 2;

export function MediaGrid({
  items,
  loading,
  refreshing,
  hasMore,
  onRefresh,
  onLoadMore,
  onPressItem,
  ListEmptyComponent,
  ListHeaderComponent,
}: {
  items: MediaItem[];
  loading: boolean;
  refreshing: boolean;
  hasMore: boolean;
  onRefresh: () => void;
  onLoadMore?: () => void;
  onPressItem: (item: MediaItem, index: number) => void;
  ListEmptyComponent?: React.ReactElement;
  ListHeaderComponent?: React.ReactElement;
}) {
  const { client } = useAuth();
  const { width } = useWindowDimensions();
  const cellSize = Math.floor((width - GAP * (COLUMNS - 1)) / COLUMNS);

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      numColumns={COLUMNS}
      columnWrapperStyle={styles.row}
      contentContainerStyle={items.length === 0 ? styles.emptyContainer : styles.listContent}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
      onEndReached={() => {
        if (hasMore && !loading && onLoadMore) {
          onLoadMore();
        }
      }}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={ListHeaderComponent}
      ListEmptyComponent={ListEmptyComponent}
      renderItem={({ item, index }) => {
        const isVideo =
          item.category === 'video' ||
          Boolean(item.mime_type?.startsWith('video/'));
        const thumbSource = client?.thumbnailSource(item.id);
        return (
          <Pressable
            onPress={() => onPressItem(item, index)}
            style={({ pressed }) => [
              styles.cell,
              { width: cellSize, height: cellSize },
              pressed && styles.cellPressed,
            ]}
          >
            {thumbSource ? (
              <Image
                source={thumbSource}
                style={styles.thumb}
                contentFit="cover"
                transition={120}
                cachePolicy="memory-disk"
              />
            ) : null}
            {isVideo ? (
              <View style={styles.videoBadge}>
                <Ionicons name="play" size={10} color={colors.white} />
                {item.media.duration_seconds ? (
                  <Text style={styles.videoDuration}>
                    {formatDuration(item.media.duration_seconds)}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: spacing.xxxl,
  },
  emptyContainer: {
    flexGrow: 1,
  },
  row: {
    gap: GAP,
    marginBottom: GAP,
  },
  cell: {
    backgroundColor: colors.surfaceSubtle,
    overflow: 'hidden',
    position: 'relative',
  },
  cellPressed: {
    opacity: 0.78,
  },
  thumb: {
    width: '100%',
    height: '100%',
  },
  videoBadge: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(11, 17, 24, 0.72)',
  },
  videoDuration: {
    color: colors.white,
    fontSize: 10.5,
    fontWeight: '700',
  },
});
