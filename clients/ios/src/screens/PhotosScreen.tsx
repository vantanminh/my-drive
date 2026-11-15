import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

import { LanStatusBadge } from '../components/LanStatusBadge';
import { MediaGrid } from '../components/MediaGrid';
import {
  ShareLinkModal,
  type ShareTargetSubject,
} from '../components/ShareLinkModal';
import { TextPromptModal } from '../components/TextPromptModal';
import { Banner, EmptyState } from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import type { MainTabParamList, RootStackParamList } from '../navigation/types';
import { colors, radius, spacing } from '../theme/tokens';
import type { Album, FaceCluster, MediaItem } from '../types/mydrive';

type PhotosSubTab = 'timeline' | 'albums' | 'people';

export function PhotosScreen() {
  const { client } = useAuth();
  const { snapshot, icloudSummary } = useSync();
  const rootNav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const tabNav = useNavigation<BottomTabNavigationProp<MainTabParamList>>();
  const { width } = useWindowDimensions();

  const [subTab, setSubTab] = useState<PhotosSubTab>('timeline');
  const [photos, setPhotos] = useState<MediaItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingPhotos, setLoadingPhotos] = useState(true);
  const [refreshingPhotos, setRefreshingPhotos] = useState(false);

  const [albums, setAlbums] = useState<Album[]>([]);
  const [loadingAlbums, setLoadingAlbums] = useState(false);
  const [createAlbumOpen, setCreateAlbumOpen] = useState(false);
  const [shareSubject, setShareSubject] = useState<ShareTargetSubject | null>(null);

  const [faces, setFaces] = useState<FaceCluster[]>([]);
  const [loadingFaces, setLoadingFaces] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadTimeline = useCallback(
    async (cursor?: string | null, replace = false) => {
      if (!client) return;
      if (replace) setErrorMsg(null);
      try {
        const page = await client.listPhotos(cursor ?? undefined, 60);
        setPhotos((prev) => (replace ? page.items : [...prev, ...page.items]));
        setNextCursor(page.next_cursor);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingPhotos(false);
        setRefreshingPhotos(false);
      }
    },
    [client],
  );

  const loadAlbums = useCallback(async () => {
    if (!client) return;
    setLoadingAlbums(true);
    setErrorMsg(null);
    try {
      const list = await client.listAlbums();
      setAlbums(list);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingAlbums(false);
    }
  }, [client]);

  const loadFaces = useCallback(async () => {
    if (!client) return;
    setLoadingFaces(true);
    try {
      const page = await client.listFaces(0, { limit: 80 });
      setFaces(page.clusters);
    } catch {
      // Faces index may not have clusters yet on a fresh server.
    } finally {
      setLoadingFaces(false);
    }
  }, [client]);

  useEffect(() => {
    void loadTimeline(null, true);
    void loadAlbums();
    void loadFaces();
  }, [loadTimeline, loadAlbums, loadFaces]);

  const handleRefreshTimeline = () => {
    setRefreshingPhotos(true);
    void loadTimeline(null, true);
  };

  const handleCreateAlbum = async (name: string) => {
    if (!client) return;
    const created = await client.createAlbum(name);
    setAlbums((prev) => [created, ...prev]);
    setCreateAlbumOpen(false);
  };

  const albumCardWidth = Math.floor((width - spacing.lg * 2 - spacing.md) / 2);
  const faceCardWidth = Math.floor((width - spacing.lg * 2 - spacing.md * 2) / 3);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View>
            <Text style={styles.title}>Photos</Text>
            <Text style={styles.subtitle}>
              {snapshot.running
                ? `Syncing ${snapshot.processedCount}/${snapshot.totalDiscovered} originals…`
                : icloudSummary.inICloudCount > 0
                  ? `${icloudSummary.inICloudCount} recent iCloud items ready to sync`
                  : 'Your personal NAS timeline & albums'}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <LanStatusBadge compact />
            {subTab === 'albums' ? (
              <Pressable
                onPress={() => setCreateAlbumOpen(true)}
                style={({ pressed }) => [
                  styles.iconBtn,
                  pressed && styles.iconBtnPressed,
                ]}
              >
                <Ionicons name="add" size={22} color={colors.accent} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => tabNav.navigate('Sync')}
              style={({ pressed }) => [
                styles.syncChip,
                pressed && styles.syncChipPressed,
              ]}
            >
              <Ionicons
                name={snapshot.running ? 'sync' : 'cloud-upload-outline'}
                size={15}
                color={colors.accent}
              />
              <Text style={styles.syncChipText}>
                {snapshot.running ? 'Syncing' : 'Backup'}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.segmented}>
          <Pressable
            onPress={() => setSubTab('timeline')}
            style={[
              styles.segmentBtn,
              subTab === 'timeline' && styles.segmentBtnActive,
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                subTab === 'timeline' && styles.segmentTextActive,
              ]}
            >
              Timeline
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setSubTab('albums')}
            style={[
              styles.segmentBtn,
              subTab === 'albums' && styles.segmentBtnActive,
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                subTab === 'albums' && styles.segmentTextActive,
              ]}
            >
              Albums ({albums.length})
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setSubTab('people')}
            style={[
              styles.segmentBtn,
              subTab === 'people' && styles.segmentBtnActive,
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                subTab === 'people' && styles.segmentTextActive,
              ]}
            >
              People{faces.length > 0 ? ` (${faces.length})` : ''}
            </Text>
          </Pressable>
        </View>
      </View>

      {errorMsg ? (
        <View style={styles.bannerWrap}>
          <Banner tone="danger" icon="alert-circle-outline" message={errorMsg} />
        </View>
      ) : null}

      {subTab === 'timeline' ? (
        loadingPhotos && photos.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.accent} />
          </View>
        ) : (
          <MediaGrid
            items={photos}
            loading={loadingPhotos}
            refreshing={refreshingPhotos}
            hasMore={Boolean(nextCursor)}
            onRefresh={handleRefreshTimeline}
            onLoadMore={() => {
              if (nextCursor) {
                setLoadingPhotos(true);
                void loadTimeline(nextCursor, false);
              }
            }}
            onPressItem={(_item, index) => {
              rootNav.navigate('PhotoViewer', {
                items: photos,
                initialIndex: index,
                title: 'Photos',
              });
            }}
            ListEmptyComponent={
              <EmptyState
                icon="images-outline"
                title="No Photos on NAS Yet"
                message="Sync originals from your iPhone Photo Library or upload media files to view them here."
                actionTitle="Set Up Photo Backup"
                onAction={() => tabNav.navigate('Sync')}
              />
            }
          />
        )
      ) : subTab === 'albums' ? (
        <FlatList
          key="albums-grid"
          data={albums}
          keyExtractor={(item) => item.id}
          numColumns={2}
          columnWrapperStyle={styles.albumRow}
          contentContainerStyle={
            albums.length === 0 ? styles.emptyContainer : styles.albumGrid
          }
          refreshControl={
            <RefreshControl
              refreshing={loadingAlbums}
              onRefresh={() => {
                void loadAlbums();
              }}
              tintColor={colors.accent}
            />
          }
          ListEmptyComponent={
            loadingAlbums ? (
              <View style={styles.center}>
                <ActivityIndicator size="large" color={colors.accent} />
              </View>
            ) : (
              <EmptyState
                icon="albums-outline"
                title="No Albums Yet"
                message="Group favorite memories or trips into albums on your MyDrive NAS."
                actionTitle="Create Album"
                onAction={() => setCreateAlbumOpen(true)}
              />
            )
          }
          renderItem={({ item }) => {
            const coverSource = item.cover_file_id
              ? client?.thumbnailSource(item.cover_file_id)
              : null;
            return (
              <Pressable
                onPress={() => rootNav.navigate('AlbumDetail', { album: item })}
                style={({ pressed }) => [
                  styles.albumCard,
                  { width: albumCardWidth },
                  pressed && styles.albumCardPressed,
                ]}
              >
                <View style={styles.albumCoverWrap}>
                  {coverSource ? (
                    <Image
                      source={coverSource}
                      style={styles.albumCover}
                      contentFit="cover"
                      cachePolicy="memory-disk"
                    />
                  ) : (
                    <View style={styles.albumPlaceholder}>
                      <Ionicons
                        name="images-outline"
                        size={30}
                        color={colors.accent}
                      />
                    </View>
                  )}
                </View>
                <View style={styles.albumFooterRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.albumTitle} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.albumCount}>
                      {item.item_count} {item.item_count === 1 ? 'item' : 'items'}
                    </Text>
                  </View>
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      setShareSubject({
                        resourceType: 'album',
                        resourceId: item.id,
                        name: item.name,
                      });
                    }}
                    hitSlop={8}
                    style={styles.albumShareBtn}
                  >
                    <Ionicons name="share-outline" size={16} color={colors.accent} />
                  </Pressable>
                </View>
              </Pressable>
            );
          }}
        />
      ) : subTab === 'people' ? (
        <FlatList
          key="people-grid"
          data={faces}
          keyExtractor={(item) => item.id}
          numColumns={3}
          columnWrapperStyle={styles.faceRow}
          contentContainerStyle={
            faces.length === 0 ? styles.emptyContainer : styles.albumGrid
          }
          refreshControl={
            <RefreshControl
              refreshing={loadingFaces}
              onRefresh={() => {
                void loadFaces();
              }}
              tintColor={colors.accent}
            />
          }
          ListEmptyComponent={
            loadingFaces ? (
              <View style={styles.center}>
                <ActivityIndicator size="large" color={colors.accent} />
              </View>
            ) : (
              <EmptyState
                icon="people-outline"
                title="No People Grouped Yet"
                message="As your NAS finishes indexing portraits, people clusters will appear here automatically."
              />
            )
          }
          renderItem={({ item }) => {
            const portraitSource = item.representativeFileId
              ? client?.thumbnailSource(item.representativeFileId)
              : null;
            return (
              <Pressable
                onPress={() => rootNav.navigate('PersonDetail', { cluster: item })}
                style={({ pressed }) => [
                  styles.faceCard,
                  { width: faceCardWidth },
                  pressed && styles.albumCardPressed,
                ]}
              >
                <View style={styles.faceAvatarWrap}>
                  {portraitSource ? (
                    <Image
                      source={portraitSource}
                      style={styles.albumCover}
                      contentFit="cover"
                      cachePolicy="memory-disk"
                    />
                  ) : (
                    <View style={styles.albumPlaceholder}>
                      <Ionicons name="person-outline" size={28} color={colors.accent} />
                    </View>
                  )}
                </View>
                <Text
                  style={[
                    styles.faceLabel,
                    !item.label && styles.faceLabelUnnamed,
                  ]}
                  numberOfLines={1}
                >
                  {item.label?.trim() || 'Add a name'}
                </Text>
                <Text style={styles.faceCount}>
                  {item.assetCount} {item.assetCount === 1 ? 'photo' : 'photos'}
                </Text>
              </Pressable>
            );
          }}
        />
      ) : null}

      <TextPromptModal
        visible={createAlbumOpen}
        title="New Album"
        placeholder="Summer Trip, Family, Architecture…"
        confirmLabel="Create"
        onCancel={() => setCreateAlbumOpen(false)}
        onSubmit={handleCreateAlbum}
      />

      <ShareLinkModal
        visible={Boolean(shareSubject)}
        subject={shareSubject}
        onClose={() => setShareSubject(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    gap: spacing.md,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnPressed: {
    backgroundColor: '#d7ebe2',
  },
  syncChip: {
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
  syncChipPressed: {
    backgroundColor: '#d7ebe2',
  },
  syncChipText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.accentDark,
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radius.md,
    padding: 3,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.sm + 2,
    alignItems: 'center',
  },
  segmentBtnActive: {
    backgroundColor: colors.surface,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  segmentText: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.muted,
  },
  segmentTextActive: {
    color: colors.ink,
    fontWeight: '700',
  },
  bannerWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContainer: {
    flexGrow: 1,
  },
  albumGrid: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  albumRow: {
    gap: spacing.md,
  },
  albumCard: {
    gap: spacing.xs,
  },
  albumCardPressed: {
    opacity: 0.85,
  },
  albumCoverWrap: {
    aspectRatio: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.line,
  },
  albumCover: {
    width: '100%',
    height: '100%',
  },
  albumPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentTint,
  },
  albumTitle: {
    fontSize: 14.5,
    fontWeight: '700',
    color: colors.ink,
    marginTop: 2,
  },
  albumFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 2,
  },
  albumShareBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  albumCount: {
    fontSize: 12.5,
    color: colors.muted,
  },
  faceRow: {
    gap: spacing.md,
  },
  faceCard: {
    alignItems: 'center',
    gap: 4,
    marginBottom: spacing.md,
  },
  faceAvatarWrap: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.line,
  },
  faceLabel: {
    fontSize: 13.5,
    fontWeight: '700',
    color: colors.ink,
    marginTop: 2,
  },
  faceLabelUnnamed: {
    color: colors.accent,
  },
  faceCount: {
    fontSize: 12,
    color: colors.muted,
  },
});
