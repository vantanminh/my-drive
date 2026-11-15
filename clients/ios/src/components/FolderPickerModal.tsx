import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../context/AuthContext';
import { colors, radius, spacing } from '../theme/tokens';
import type { Breadcrumb, Entry } from '../types/mydrive';
import { AppButton } from './UiPrimitives';

export function FolderPickerModal({
  visible,
  title = 'Choose Destination Folder',
  confirmLabel = 'Move Here',
  excludedIds = [],
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  title?: string;
  confirmLabel?: string;
  excludedIds?: string[];
  onCancel: () => void;
  onConfirm: (targetFolderId: string | null, folderName: string) => Promise<void> | void;
}) {
  const { client } = useAuth();
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [folders, setFolders] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const currentFolderId =
    breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].id : null;
  const currentFolderName =
    breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].name : 'My Drive';

  const loadFolders = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const page = await client.listFolder({
        parentId: currentFolderId,
        limit: 100,
        sortBy: 'name',
        order: 'asc',
      });
      const excluded = new Set(excludedIds);
      setFolders(
        page.entries.filter(
          (entry) => entry.kind === 'folder' && !excluded.has(entry.id),
        ),
      );
    } catch {
      setFolders([]);
    } finally {
      setLoading(false);
    }
  }, [client, currentFolderId, excludedIds]);

  useEffect(() => {
    if (visible) {
      setBreadcrumbs([]);
      setSubmitting(false);
    }
  }, [visible]);

  useEffect(() => {
    if (visible) {
      void loadFolders();
    }
  }, [visible, loadFolders]);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(currentFolderId, currentFolderName);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onCancel}
    >
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.flex}>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.subtitle}>Destination: {currentFolderName}</Text>
            </View>
            <Pressable onPress={onCancel} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.muted} />
            </Pressable>
          </View>

          {breadcrumbs.length > 0 ? (
            <Pressable
              onPress={() => setBreadcrumbs((prev) => prev.slice(0, -1))}
              style={styles.upRow}
            >
              <Ionicons name="arrow-up-outline" size={18} color={colors.accent} />
              <Text style={styles.upText}>Up to Parent Folder</Text>
            </Pressable>
          ) : null}

          <View style={styles.listBox}>
            {loading ? (
              <View style={styles.center}>
                <ActivityIndicator size="small" color={colors.accent} />
              </View>
            ) : folders.length === 0 ? (
              <View style={styles.center}>
                <Text style={styles.emptyText}>No subfolders inside {currentFolderName}</Text>
              </View>
            ) : (
              <FlatList
                data={folders}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() =>
                      setBreadcrumbs((prev) => [...prev, { id: item.id, name: item.name }])
                    }
                    style={({ pressed }) => [
                      styles.folderRow,
                      pressed && styles.folderRowPressed,
                    ]}
                  >
                    <Ionicons
                      name={item.system_role === 'photos' ? 'images' : 'folder'}
                      size={20}
                      color={colors.accent}
                    />
                    <Text style={styles.folderName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Ionicons name="chevron-forward" size={17} color={colors.muted} />
                  </Pressable>
                )}
              />
            )}
          </View>

          <View style={styles.actions}>
            <AppButton
              title="Cancel"
              variant="subtle"
              compact
              onPress={onCancel}
              style={styles.actionBtn}
            />
            <AppButton
              title={confirmLabel}
              variant="primary"
              compact
              loading={submitting}
              onPress={() => void handleConfirm()}
              style={styles.actionBtn}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 25, 34, 0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    gap: spacing.md,
    maxHeight: '80%',
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  title: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.ink,
  },
  subtitle: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 2,
  },
  upRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs + 2,
  },
  upText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.accentDark,
  },
  listBox: {
    minHeight: 180,
    maxHeight: 300,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  center: {
    flex: 1,
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  emptyText: {
    fontSize: 13.5,
    color: colors.muted,
  },
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  folderRowPressed: {
    backgroundColor: colors.surfaceSubtle,
  },
  folderName: {
    flex: 1,
    fontSize: 14.5,
    fontWeight: '600',
    color: colors.ink,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  actionBtn: {
    flex: 1,
  },
});
