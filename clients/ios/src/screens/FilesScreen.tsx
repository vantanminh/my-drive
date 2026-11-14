import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';

import { downloadToLocalFile } from '../../modules/mydrive-media-sync/src';
import { TextPromptModal } from '../components/TextPromptModal';
import { Banner, EmptyState } from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import { uploadLocalDocument } from '../services/fileUpload';
import { formatBytes, formatShortDate, resolveViewerKind } from '../services/format';
import { colors, radius, spacing } from '../theme/tokens';
import type { Breadcrumb, Entry } from '../types/mydrive';

type SortField = 'updated_at' | 'name' | 'size';

function iconForEntry(entry: Entry): {
  name: keyof typeof Ionicons.glyphMap;
  tint: string;
  bg: string;
} {
  if (entry.kind === 'folder') {
    return {
      name: entry.system_role === 'photos' ? 'images' : 'folder',
      tint: colors.accent,
      bg: colors.accentTint,
    };
  }
  const kind = resolveViewerKind(entry.name, entry.mime_detected, entry.category);
  switch (kind) {
    case 'image':
      return { name: 'image-outline', tint: '#1b6d9c', bg: '#e8f3fa' };
    case 'video':
      return { name: 'videocam-outline', tint: '#7b4ca0', bg: '#f2ebf8' };
    case 'pdf':
      return { name: 'document-text-outline', tint: '#b75252', bg: '#fdeeee' };
    case 'office':
      return { name: 'grid-outline', tint: '#1c8057', bg: '#e6f5ee' };
    case 'text':
      return { name: 'code-slash-outline', tint: '#46586b', bg: '#edf1f5' };
    default:
      return { name: 'document-outline', tint: colors.inkSoft, bg: colors.surfaceSubtle };
  }
}

export function FilesScreen() {
  const { client } = useAuth();
  const rootNav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [sortBy, setSortBy] = useState<SortField>('updated_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [searchQuery, setSearchQuery] = useState('');

  const [entries, setEntries] = useState<Entry[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [uploadStatus, setUploadStatus] = useState<{
    filename: string;
    phase: string;
    currentIndex: number;
    totalCount: number;
  } | null>(null);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Entry | null>(null);
  const [menuTarget, setMenuTarget] = useState<Entry | null>(null);

  const currentFolderId =
    breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].id : null;

  const loadEntries = useCallback(
    async (offset = 0, replace = false) => {
      if (!client) return;
      if (replace) setErrorMsg(null);
      try {
        const trimmedSearch = searchQuery.trim();
        const page = trimmedSearch
          ? await client.searchDrive({
              q: trimmedSearch,
              folder_id: currentFolderId ?? undefined,
              limit: 80,
              offset,
              sort_by: sortBy,
              order: sortOrder,
            })
          : await client.listFolder({
              parentId: currentFolderId,
              offset,
              limit: 80,
              sortBy,
              order: sortOrder,
            });
        setEntries((prev) => (replace ? page.entries : [...prev, ...page.entries]));
        setNextOffset(page.next_offset);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [client, currentFolderId, searchQuery, sortBy, sortOrder],
  );

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => {
      void loadEntries(0, true);
    }, searchQuery ? 220 : 0);
    return () => clearTimeout(timer);
  }, [loadEntries, searchQuery]);

  const handleOpenEntry = (entry: Entry) => {
    if (entry.kind === 'folder') {
      setSearchQuery('');
      setBreadcrumbs((prev) => [...prev, { id: entry.id, name: entry.name }]);
      return;
    }
    rootNav.navigate('FileViewer', { entry });
  };

  const handleUploadFiles = async () => {
    if (!client || uploadStatus) return;
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (picked.canceled || picked.assets.length === 0) return;

      for (let i = 0; i < picked.assets.length; i += 1) {
        const asset = picked.assets[i];
        setUploadStatus({
          filename: asset.name,
          phase: 'hashing',
          currentIndex: i + 1,
          totalCount: picked.assets.length,
        });
        await uploadLocalDocument({
          client,
          parentId: currentFolderId,
          filename: asset.name,
          fileUri: asset.uri,
          modifiedAtIso: asset.lastModified
            ? new Date(asset.lastModified).toISOString()
            : undefined,
          onPhase: (phase) => {
            setUploadStatus({
              filename: asset.name,
              phase,
              currentIndex: i + 1,
              totalCount: picked.assets.length,
            });
          },
        });
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await loadEntries(0, true);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Upload Failed', err instanceof Error ? err.message : String(err));
    } finally {
      setUploadStatus(null);
    }
  };

  const handleCreateFolder = async (name: string) => {
    if (!client) return;
    await client.createFolder(name, currentFolderId);
    setNewFolderOpen(false);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await loadEntries(0, true);
  };

  const handleRenameEntry = async (name: string) => {
    if (!client || !renameTarget) return;
    await client.renameEntry(renameTarget.id, name);
    setRenameTarget(null);
    await loadEntries(0, true);
  };

  const handleShareEntry = async (entry: Entry) => {
    if (!client || entry.kind === 'folder') return;
    setMenuTarget(null);
    try {
      const downloaded = await downloadToLocalFile(
        client.downloadUrl(entry.id),
        entry.name,
      );
      await Sharing.shareAsync(downloaded.localUri, {
        mimeType: entry.mime_detected ?? undefined,
        dialogTitle: entry.name,
      });
    } catch (err) {
      Alert.alert('Download Failed', err instanceof Error ? err.message : String(err));
    }
  };

  const handleTrashEntry = (entry: Entry) => {
    if (!client) return;
    setMenuTarget(null);
    Alert.alert(
      'Move to Trash?',
      `Move "${entry.name}" to MyDrive Trash?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Move to Trash',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await client.trashEntry(entry.id);
                await loadEntries(0, true);
              } catch (err) {
                Alert.alert('Delete Failed', err instanceof Error ? err.message : String(err));
              }
            })();
          },
        },
      ],
    );
  };

  const cycleSort = () => {
    if (sortBy === 'updated_at') {
      setSortBy('name');
      setSortOrder('asc');
    } else if (sortBy === 'name') {
      setSortBy('size');
      setSortOrder('desc');
    } else {
      setSortBy('updated_at');
      setSortOrder('desc');
    }
  };

  const sortLabel =
    sortBy === 'updated_at' ? 'Recent' : sortBy === 'name' ? 'Name' : 'Size';

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Files</Text>
          <View style={styles.headerActions}>
            <Pressable
              onPress={cycleSort}
              style={({ pressed }) => [
                styles.sortPill,
                pressed && styles.pillPressed,
              ]}
            >
              <Ionicons name="swap-vertical" size={14} color={colors.inkSoft} />
              <Text style={styles.sortText}>{sortLabel}</Text>
            </Pressable>
            <Pressable
              onPress={() => setNewFolderOpen(true)}
              style={({ pressed }) => [
                styles.iconActionBtn,
                pressed && styles.pillPressed,
              ]}
            >
              <Ionicons name="folder-open-outline" size={20} color={colors.accent} />
            </Pressable>
            <Pressable
              onPress={() => void handleUploadFiles()}
              style={({ pressed }) => [
                styles.uploadBtn,
                pressed && styles.uploadBtnPressed,
              ]}
            >
              <Ionicons name="cloud-upload-outline" size={17} color={colors.white} />
              <Text style={styles.uploadBtnText}>Upload</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.searchBox}>
          <Ionicons name="search" size={17} color={colors.muted} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search files & folders…"
            placeholderTextColor={colors.muted}
            style={styles.searchInput}
            returnKeyType="search"
          />
          {searchQuery ? (
            <Pressable onPress={() => setSearchQuery('')} hitSlop={8}>
              <Ionicons name="close-circle" size={17} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.breadcrumbsRow}
        >
          <Pressable
            onPress={() => setBreadcrumbs([])}
            style={[
              styles.crumbBtn,
              breadcrumbs.length === 0 && styles.crumbBtnActive,
            ]}
          >
            <Text
              style={[
                styles.crumbText,
                breadcrumbs.length === 0 && styles.crumbTextActive,
              ]}
            >
              My Drive
            </Text>
          </Pressable>
          {breadcrumbs.map((crumb, idx) => {
            const isLast = idx === breadcrumbs.length - 1;
            return (
              <View key={crumb.id} style={styles.crumbPair}>
                <Ionicons name="chevron-forward" size={14} color={colors.muted} />
                <Pressable
                  onPress={() => setBreadcrumbs(breadcrumbs.slice(0, idx + 1))}
                  style={[styles.crumbBtn, isLast && styles.crumbBtnActive]}
                >
                  <Text
                    style={[styles.crumbText, isLast && styles.crumbTextActive]}
                    numberOfLines={1}
                  >
                    {crumb.name}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      </View>

      {uploadStatus ? (
        <View style={styles.topNotice}>
          <Banner
            tone="accent"
            icon="cloud-upload-outline"
            title={`Uploading ${uploadStatus.currentIndex} of ${uploadStatus.totalCount}`}
            message={`${uploadStatus.filename} (${uploadStatus.phase}…)`}
          />
        </View>
      ) : null}

      {errorMsg ? (
        <View style={styles.topNotice}>
          <Banner tone="danger" icon="alert-circle-outline" message={errorMsg} />
        </View>
      ) : null}

      {loading && entries.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.id}
          contentContainerStyle={
            entries.length === 0 ? styles.emptyContainer : styles.listContent
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void loadEntries(0, true);
              }}
              tintColor={colors.accent}
            />
          }
          onEndReached={() => {
            if (nextOffset != null && !loading) {
              setLoading(true);
              void loadEntries(nextOffset, false);
            }
          }}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={
            <EmptyState
              icon={searchQuery ? 'search-outline' : 'folder-open-outline'}
              title={searchQuery ? 'No Matching Files' : 'Folder Is Empty'}
              message={
                searchQuery
                  ? `Nothing matched "${searchQuery}".`
                  : 'Upload documents, PDFs, Office files, or media directly into your NAS.'
              }
              actionTitle={searchQuery ? 'Clear Search' : 'Upload File'}
              onAction={() => {
                if (searchQuery) {
                  setSearchQuery('');
                } else {
                  void handleUploadFiles();
                }
              }}
            />
          }
          renderItem={({ item }) => {
            const visual = iconForEntry(item);
            const subtitle =
              item.kind === 'folder'
                ? `${item.folder_file_count ?? 0} files • ${formatShortDate(item.updated_at)}`
                : `${formatBytes(item.size_bytes)} • ${formatShortDate(item.updated_at)}`;
            return (
              <Pressable
                onPress={() => handleOpenEntry(item)}
                style={({ pressed }) => [
                  styles.entryRow,
                  pressed && styles.entryRowPressed,
                ]}
              >
                <View style={[styles.entryIconBox, { backgroundColor: visual.bg }]}>
                  <Ionicons name={visual.name} size={22} color={visual.tint} />
                </View>
                <View style={styles.entryBody}>
                  <Text style={styles.entryName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.entryMeta} numberOfLines={1}>
                    {subtitle}
                  </Text>
                </View>
                <Pressable
                  onPress={() => setMenuTarget(item)}
                  hitSlop={10}
                  style={styles.moreBtn}
                >
                  <Ionicons name="ellipsis-horizontal" size={18} color={colors.muted} />
                </Pressable>
              </Pressable>
            );
          }}
        />
      )}

      <TextPromptModal
        visible={newFolderOpen}
        title="New Folder"
        placeholder="Folder name"
        confirmLabel="Create"
        onCancel={() => setNewFolderOpen(false)}
        onSubmit={handleCreateFolder}
      />

      <TextPromptModal
        visible={Boolean(renameTarget)}
        title="Rename"
        initialValue={renameTarget?.name ?? ''}
        placeholder="New name"
        confirmLabel="Rename"
        onCancel={() => setRenameTarget(null)}
        onSubmit={handleRenameEntry}
      />

      <Modal
        visible={Boolean(menuTarget)}
        transparent
        animationType="slide"
        onRequestClose={() => setMenuTarget(null)}
      >
        <View style={styles.menuBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setMenuTarget(null)}
          />
          {menuTarget ? (
            <View style={styles.menuSheet}>
              <Text style={styles.menuTitle} numberOfLines={1}>
                {menuTarget.name}
              </Text>
              <Pressable
                onPress={() => {
                  const target = menuTarget;
                  setMenuTarget(null);
                  handleOpenEntry(target);
                }}
                style={styles.menuItem}
              >
                <Ionicons name="eye-outline" size={20} color={colors.ink} />
                <Text style={styles.menuItemText}>
                  {menuTarget.kind === 'folder' ? 'Open Folder' : 'View File'}
                </Text>
              </Pressable>
              {menuTarget.kind === 'file' ? (
                <Pressable
                  onPress={() => void handleShareEntry(menuTarget)}
                  style={styles.menuItem}
                >
                  <Ionicons name="share-outline" size={20} color={colors.ink} />
                  <Text style={styles.menuItemText}>Download & Share</Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => {
                  const target = menuTarget;
                  setMenuTarget(null);
                  setRenameTarget(target);
                }}
                style={styles.menuItem}
              >
                <Ionicons name="pencil-outline" size={20} color={colors.ink} />
                <Text style={styles.menuItemText}>Rename</Text>
              </Pressable>
              <Pressable
                onPress={() => handleTrashEntry(menuTarget)}
                style={styles.menuItem}
              >
                <Ionicons name="trash-outline" size={20} color={colors.danger} />
                <Text style={[styles.menuItemText, { color: colors.danger }]}>
                  Move to Trash
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    gap: spacing.sm + 2,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.5,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sortPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.line,
  },
  pillPressed: {
    backgroundColor: colors.surfacePressed,
  },
  sortText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.inkSoft,
  },
  iconActionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  uploadBtnPressed: {
    backgroundColor: colors.accentDark,
  },
  uploadBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.white,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 40,
  },
  searchInput: {
    flex: 1,
    fontSize: 14.5,
    color: colors.ink,
  },
  breadcrumbsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
  },
  crumbPair: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  crumbBtn: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 4,
    borderRadius: radius.pill,
    maxWidth: 160,
  },
  crumbBtnActive: {
    backgroundColor: colors.accentTint,
  },
  crumbText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
  },
  crumbTextActive: {
    color: colors.accentDark,
    fontWeight: '700',
  },
  topNotice: {
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
  listContent: {
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.xxxl,
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  entryRowPressed: {
    backgroundColor: colors.surfaceSubtle,
  },
  entryIconBox: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  entryBody: {
    flex: 1,
  },
  entryName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink,
  },
  entryMeta: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 2,
  },
  moreBtn: {
    padding: spacing.xs,
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  menuSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
    gap: spacing.xs,
  },
  menuTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.ink,
    marginBottom: spacing.sm,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  menuItemText: {
    fontSize: 15.5,
    fontWeight: '600',
    color: colors.ink,
  },
});
