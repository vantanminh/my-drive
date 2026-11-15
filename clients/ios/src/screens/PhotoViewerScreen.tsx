import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';

import { downloadToLocalFile } from '../../modules/mydrive-media-sync/src';
import { ShareLinkModal } from '../components/ShareLinkModal';
import { AppButton, KeyValueRow } from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import {
  formatBytes,
  formatDateTime,
  formatShortDate,
  resolveViewerKind,
} from '../services/format';
import { colors, radius, spacing } from '../theme/tokens';
import type { Album, EntryDetails, MediaItem } from '../types/mydrive';

type Props = NativeStackScreenProps<RootStackParamList, 'PhotoViewer'>;

function VideoSlide({
  uri,
  active,
  width,
  height,
}: {
  uri: string;
  active: boolean;
  width: number;
  height: number;
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });

  useEffect(() => {
    if (!active) {
      player.pause();
    }
  }, [active, player]);

  return (
    <View style={[styles.slide, { width, height }]}>
      <VideoView
        player={player}
        style={{ width, height: height * 0.8 }}
        nativeControls
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
      />
    </View>
  );
}

function ImageSlide({
  previewUri,
  fallbackUri,
  width,
  height,
  onToggleChrome,
}: {
  previewUri: string;
  fallbackUri: string;
  width: number;
  height: number;
  onToggleChrome: () => void;
}) {
  const [uri, setUri] = useState(previewUri);
  const [loading, setLoading] = useState(true);

  return (
    <ScrollView
      style={{ width, height }}
      contentContainerStyle={styles.zoomContainer}
      minimumZoomScale={1}
      maximumZoomScale={4}
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
    >
      <Pressable
        onPress={onToggleChrome}
        style={[styles.slide, { width, height }]}
      >
        <Image
          source={{ uri }}
          style={{ width, height }}
          contentFit="contain"
          onLoadEnd={() => setLoading(false)}
          onError={() => {
            if (uri !== fallbackUri) {
              setUri(fallbackUri);
            } else {
              setLoading(false);
            }
          }}
        />
        {loading ? (
          <View style={styles.slideLoader}>
            <ActivityIndicator size="large" color={colors.white} />
          </View>
        ) : null}
      </Pressable>
    </ScrollView>
  );
}

export function PhotoViewerScreen({ navigation, route }: Props) {
  const { client } = useAuth();
  const { width, height } = useWindowDimensions();
  const [items, setItems] = useState<MediaItem[]>(route.params.items);
  const [currentIndex, setCurrentIndex] = useState(() =>
    Math.min(
      Math.max(0, route.params.initialIndex),
      Math.max(0, route.params.items.length - 1),
    ),
  );
  const [chromeVisible, setChromeVisible] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [details, setDetails] = useState<EntryDetails | null>(null);
  const [albumPickerOpen, setAlbumPickerOpen] = useState(false);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [shareLinkOpen, setShareLinkOpen] = useState(false);
  const listRef = useRef<FlatList<MediaItem>>(null);

  const currentItem = items[currentIndex];

  useEffect(() => {
    if (!currentItem || !infoOpen || !client) return;
    setDetails(null);
    void client
      .getEntryDetails(currentItem.id)
      .then((res) => setDetails(res))
      .catch(() => {});
  }, [currentItem, infoOpen, client]);

  const handleMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = event.nativeEvent.contentOffset.x;
      const idx = Math.round(x / Math.max(1, width));
      if (idx >= 0 && idx < items.length) {
        setCurrentIndex(idx);
      }
    },
    [width, items.length],
  );

  const handleSaveToPhotos = async () => {
    if (!client || !currentItem || busyAction) return;
    setBusyAction('Saving original photo…');
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) {
        Alert.alert(
          'Permission Required',
          'Allow MyDrive to add photos to your iPhone Photo Library in Settings.',
        );
        return;
      }
      const downloaded = await downloadToLocalFile(
        client.downloadUrl(currentItem.id),
        currentItem.name,
      );
      await MediaLibrary.Asset.create(downloaded.localUri);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Saved to Photos', `${currentItem.name} saved to your Photo Library.`);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Save Failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const sendOriginalFile = async () => {
    if (!client || !currentItem || busyAction) return;
    setBusyAction('Preparing original for Share…');
    try {
      const downloaded = await downloadToLocalFile(
        client.downloadUrl(currentItem.id),
        currentItem.name,
      );
      await Sharing.shareAsync(downloaded.localUri, {
        mimeType: currentItem.mime_type ?? undefined,
        dialogTitle: currentItem.name,
      });
    } catch (err) {
      Alert.alert('Share Failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleShare = () => {
    if (!currentItem || busyAction) return;
    Alert.alert(currentItem.name, 'How would you like to share this item?', [
      {
        text: 'Create Public Link',
        onPress: () => setShareLinkOpen(true),
      },
      {
        text: 'Send Original File',
        onPress: () => void sendOriginalFile(),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const openAlbumPicker = async () => {
    if (!client) return;
    try {
      const list = await client.listAlbums();
      setAlbums(list);
      setAlbumPickerOpen(true);
    } catch (err) {
      Alert.alert('Could Not Load Albums', err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddToAlbum = async (album: Album) => {
    if (!client || !currentItem) return;
    try {
      await client.addAlbumItems(album.id, [currentItem.id]);
      setAlbumPickerOpen(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Added to Album', `Added to "${album.name}".`);
    } catch (err) {
      Alert.alert('Add Failed', err instanceof Error ? err.message : String(err));
    }
  };

  const handleTrash = () => {
    if (!client || !currentItem || busyAction) return;
    Alert.alert(
      'Move to Trash?',
      `Move "${currentItem.name}" to MyDrive Trash?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Move to Trash',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await client.trashEntry(currentItem.id);
                const nextItems = items.filter((item) => item.id !== currentItem.id);
                if (nextItems.length === 0) {
                  navigation.goBack();
                  return;
                }
                setItems(nextItems);
                setCurrentIndex((prev) => Math.min(prev, nextItems.length - 1));
              } catch (err) {
                Alert.alert('Delete Failed', err instanceof Error ? err.message : String(err));
              }
            })();
          },
        },
      ],
    );
  };

  const resolutionLabel = useMemo(() => {
    if (!currentItem) return '';
    if (currentItem.media.width && currentItem.media.height) {
      return `${currentItem.media.width} × ${currentItem.media.height}`;
    }
    return '';
  }, [currentItem]);

  if (!currentItem || !client) {
    return <View style={styles.root} />;
  }

  return (
    <View style={styles.root}>
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(item) => item.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={currentIndex}
        getItemLayout={(_data, index) => ({
          length: width,
          offset: width * index,
          index,
        })}
        onMomentumScrollEnd={handleMomentumEnd}
        renderItem={({ item, index }) => {
          const kind = resolveViewerKind(item.name, item.mime_type, item.category);
          const previewUri = client.previewUrl(item.id);
          const downloadUri = client.downloadUrl(item.id);

          if (kind === 'video') {
            return (
              <VideoSlide
                uri={previewUri}
                active={index === currentIndex}
                width={width}
                height={height}
              />
            );
          }
          return (
            <ImageSlide
              previewUri={previewUri}
              fallbackUri={downloadUri}
              width={width}
              height={height}
              onToggleChrome={() => setChromeVisible((prev) => !prev)}
            />
          );
        }}
      />

      {chromeVisible ? (
        <>
          <SafeAreaView style={styles.topOverlay} edges={['top']}>
            <View style={styles.topBar}>
              <Pressable
                onPress={() => navigation.goBack()}
                style={styles.chromeIconBtn}
                hitSlop={8}
              >
                <Ionicons name="close" size={24} color={colors.white} />
              </Pressable>
              <View style={styles.topTitleWrap}>
                <Text style={styles.topTitle} numberOfLines={1}>
                  {currentItem.name}
                </Text>
                <Text style={styles.topSubtitle} numberOfLines={1}>
                  {formatShortDate(currentItem.media.taken_at ?? currentItem.updated_at)}
                  {resolutionLabel ? ` • ${resolutionLabel}` : ''}
                </Text>
              </View>
              <Pressable
                onPress={() => setInfoOpen(true)}
                style={styles.chromeIconBtn}
                hitSlop={8}
              >
                <Ionicons name="information-circle-outline" size={24} color={colors.white} />
              </Pressable>
            </View>
          </SafeAreaView>

          <SafeAreaView style={styles.bottomOverlay} edges={['bottom']}>
            <View style={styles.bottomBar}>
              <Pressable onPress={() => void handleShare()} style={styles.toolBtn}>
                <Ionicons name="share-outline" size={22} color={colors.white} />
                <Text style={styles.toolLabel}>Share</Text>
              </Pressable>
              <Pressable onPress={() => void handleSaveToPhotos()} style={styles.toolBtn}>
                <Ionicons name="download-outline" size={22} color={colors.white} />
                <Text style={styles.toolLabel}>Save Copy</Text>
              </Pressable>
              <Pressable onPress={() => void openAlbumPicker()} style={styles.toolBtn}>
                <Ionicons name="albums-outline" size={22} color={colors.white} />
                <Text style={styles.toolLabel}>Album</Text>
              </Pressable>
              <Pressable onPress={handleTrash} style={styles.toolBtn}>
                <Ionicons name="trash-outline" size={22} color="#ff8e8e" />
                <Text style={[styles.toolLabel, { color: '#ff8e8e' }]}>Trash</Text>
              </Pressable>
            </View>
          </SafeAreaView>
        </>
      ) : null}

      {busyAction ? (
        <View style={[StyleSheet.absoluteFill, styles.busyOverlay]}>
          <View style={styles.busyBox}>
            <ActivityIndicator size="large" color={colors.white} />
            <Text style={styles.busyText}>{busyAction}</Text>
          </View>
        </View>
      ) : null}

      <Modal
        visible={infoOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setInfoOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setInfoOpen(false)} />
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Photo Details</Text>
            <KeyValueRow label="Filename" value={currentItem.name} />
            <KeyValueRow label="File Size" value={formatBytes(currentItem.size_bytes)} />
            <KeyValueRow label="Format" value={currentItem.mime_type ?? currentItem.category} />
            {resolutionLabel ? <KeyValueRow label="Dimensions" value={resolutionLabel} /> : null}
            <KeyValueRow
              label="Captured"
              value={formatDateTime(currentItem.media.taken_at ?? currentItem.created_at)}
            />
            {details ? (
              <KeyValueRow label="NAS Location" value={details.location || '/'} last />
            ) : null}
            <AppButton
              title="Close"
              variant="subtle"
              compact
              onPress={() => setInfoOpen(false)}
              style={styles.modalCloseBtn}
            />
          </View>
        </View>
      </Modal>

      <Modal
        visible={albumPickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setAlbumPickerOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setAlbumPickerOpen(false)}
          />
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Add to Album</Text>
            {albums.length === 0 ? (
              <Text style={styles.noAlbumsText}>
                Create an album in the Photos → Albums tab first.
              </Text>
            ) : (
              <ScrollView style={styles.albumList}>
                {albums.map((album) => (
                  <Pressable
                    key={album.id}
                    onPress={() => void handleAddToAlbum(album)}
                    style={({ pressed }) => [
                      styles.albumPickRow,
                      pressed && styles.albumPickRowPressed,
                    ]}
                  >
                    <Ionicons name="albums-outline" size={20} color={colors.accent} />
                    <Text style={styles.albumPickName}>{album.name}</Text>
                    <Text style={styles.albumPickCount}>{album.item_count}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            <AppButton
              title="Cancel"
              variant="subtle"
              compact
              onPress={() => setAlbumPickerOpen(false)}
              style={styles.modalCloseBtn}
            />
          </View>
        </View>
      </Modal>

      <ShareLinkModal
        visible={shareLinkOpen && Boolean(currentItem)}
        subject={
          currentItem
            ? {
                resourceType: 'file',
                resourceId: currentItem.id,
                name: currentItem.name,
              }
            : null
        }
        onClose={() => setShareLinkOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.viewerBg,
  },
  zoomContainer: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  slide: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  slideLoader: {
    position: 'absolute',
    inset: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  topOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.viewerChrome,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  chromeIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitleWrap: {
    flex: 1,
  },
  topTitle: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '700',
  },
  topSubtitle: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    marginTop: 1,
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.viewerChrome,
  },
  bottomBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  toolBtn: {
    alignItems: 'center',
    gap: 4,
    minWidth: 64,
  },
  toolLabel: {
    color: colors.white,
    fontSize: 11.5,
    fontWeight: '600',
  },
  busyOverlay: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  busyBox: {
    backgroundColor: 'rgba(20, 28, 36, 0.92)',
    padding: spacing.xl,
    borderRadius: radius.lg,
    alignItems: 'center',
    gap: spacing.md,
  },
  busyText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.ink,
    marginBottom: spacing.md,
  },
  modalCloseBtn: {
    marginTop: spacing.lg,
  },
  albumList: {
    maxHeight: 280,
  },
  albumPickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  albumPickRowPressed: {
    backgroundColor: colors.surfaceSubtle,
  },
  albumPickName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink,
  },
  albumPickCount: {
    fontSize: 13,
    color: colors.muted,
  },
  noAlbumsText: {
    fontSize: 14,
    color: colors.muted,
    paddingVertical: spacing.md,
  },
});
