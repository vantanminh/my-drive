import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import { Ionicons } from '@expo/vector-icons';

import { TextPromptModal } from '../components/TextPromptModal';
import {
  AppButton,
  Banner,
  Card,
  SectionTitle,
  StatusBadge,
} from '../components/UiPrimitives';
import { useSync } from '../context/SyncContext';
import { formatBytes, formatDateTime } from '../services/format';
import { formatEta, formatSpeed } from '../services/uploadTracker';
import { colors, radius, spacing } from '../theme/tokens';
import type { SyncLedgerRecord } from '../types/mydrive';

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'scanning':
      return 'Scanning Photo Library…';
    case 'inspecting_icloud':
      return 'Checking iCloud storage status…';
    case 'downloading_icloud':
      return 'Downloading original from iCloud…';
    case 'hashing':
      return 'Verifying SHA-256 checksum…';
    case 'uploading':
      return 'Uploading chunks to NAS…';
    case 'completed':
      return 'Backup run finished';
    case 'cancelled':
      return 'Backup cancelled';
    default:
      return 'Ready';
  }
}

function ledgerStatusVisual(status: SyncLedgerRecord['status']) {
  switch (status) {
    case 'synced':
      return { tone: 'success' as const, label: 'Backed Up' };
    case 'deduplicated':
      return { tone: 'accent' as const, label: 'Deduplicated' };
    case 'icloud_waiting_wifi':
      return { tone: 'warning' as const, label: 'Waiting Wi-Fi' };
    case 'error':
      return { tone: 'danger' as const, label: 'Error' };
  }
}

export function SyncScreen() {
  const {
    settings,
    snapshot,
    ledgerRecords,
    ledgerStats,
    icloudSummary,
    scanningICloud,
    updateSettings,
    inspectICloudSample,
    requestPhotoPermission,
    startSync,
    cancelSync,
    clearLedgerHistory,
  } = useSync();

  const [folderModalOpen, setFolderModalOpen] = useState(false);

  const progressRatio =
    snapshot.totalDiscovered > 0
      ? Math.min(1, snapshot.processedCount / snapshot.totalDiscovered)
      : 0;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Photo Sync</Text>
        <Text style={styles.subtitle}>
          Backs up full-resolution iPhone & iCloud originals straight to your NAS.
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {!icloudSummary.nativeAvailable ? (
          <Banner
            tone="warning"
            icon="construct-outline"
            title="Native iOS Module Inactive"
            message="This runtime does not have MyDriveMediaSync linked yet. Build with `npx expo prebuild --platform ios` or Xcode CI to enable PhotoKit iCloud original export."
          />
        ) : null}

        {icloudSummary.permissionStatus === 'denied' ? (
          <Banner
            tone="danger"
            icon="lock-closed-outline"
            title="Photo Access Denied"
            message="Enable Photos access in iOS Settings so MyDrive can inspect and back up your library."
            actionLabel="Retry Permission"
            onAction={() => {
              void requestPhotoPermission();
            }}
          />
        ) : icloudSummary.permissionStatus === 'undetermined' ? (
          <Banner
            tone="accent"
            icon="images-outline"
            title="Allow Photo Library Access"
            message="Grant Photo access to inspect which items are stored locally vs iCloud Optimized."
            actionLabel="Grant Photo Access"
            onAction={() => {
              void requestPhotoPermission();
            }}
          />
        ) : icloudSummary.permissionStatus === 'limited' ? (
          <Banner
            tone="warning"
            icon="albums-outline"
            title="Limited Photo Access Selected"
            message="Only selected photos are visible to MyDrive. Allow more photos anytime."
            actionLabel="Manage Selection"
            onAction={() => {
              void MediaLibrary.presentPermissionsPicker();
            }}
          />
        ) : null}

        <Card style={styles.sectionCard}>
          <View style={styles.icloudHeader}>
            <View style={styles.icloudTitleRow}>
              <View style={styles.icloudIcon}>
                <Ionicons name="cloud-download-outline" size={22} color={colors.accent} />
              </View>
              <View style={styles.flex}>
                <Text style={styles.cardHeading}>iCloud Optimize Storage Check</Text>
                <Text style={styles.cardSub}>
                  Downloads full originals before hashing & uploading
                </Text>
              </View>
            </View>
            <Pressable
              onPress={() => {
                void inspectICloudSample();
              }}
              hitSlop={10}
              style={styles.refreshBtn}
            >
              {scanningICloud ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <Ionicons name="refresh" size={18} color={colors.accent} />
              )}
            </Pressable>
          </View>

          <View style={styles.metricsRow}>
            <View style={styles.metricBox}>
              <Text style={styles.metricValue}>{icloudSummary.localCount}</Text>
              <Text style={styles.metricLabel}>On Device</Text>
            </View>
            <View style={[styles.metricBox, styles.metricHighlight]}>
              <Text style={[styles.metricValue, { color: colors.accentDark }]}>
                {icloudSummary.inICloudCount}
              </Text>
              <Text style={styles.metricLabel}>iCloud Only</Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricValue}>{ledgerStats.icloudOriginalsCount}</Text>
              <Text style={styles.metricLabel}>iCloud Synced</Text>
            </View>
          </View>

          {icloudSummary.sampleInICloudNames.length > 0 ? (
            <Text style={styles.sampleText} numberOfLines={2}>
              Cloud-only assets detected: {icloudSummary.sampleInICloudNames.join(', ')}
            </Text>
          ) : icloudSummary.checked > 0 ? (
            <Text style={styles.sampleText}>
              Checked {icloudSummary.checked} recent items ({icloudSummary.livePhotoCount} Live Photos). All recent items already have originals available.
            </Text>
          ) : null}
        </Card>

        <Card style={styles.sectionCard}>
          <View style={styles.syncTopRow}>
            <View style={styles.flex}>
              <Text style={styles.cardHeading}>{phaseLabel(snapshot.phase)}</Text>
              <Text style={styles.cardSub} numberOfLines={1}>
                {snapshot.currentFilename
                  ? `${snapshot.currentFilename}${snapshot.currentInICloud ? ' (iCloud Original)' : ''}`
                  : `${ledgerStats.syncedCount + ledgerStats.dedupedCount} total photos backed up to NAS`}
              </Text>
            </View>
            <StatusBadge
              tone={
                snapshot.running
                  ? 'accent'
                  : snapshot.lastError
                    ? 'danger'
                    : 'success'
              }
              label={
                snapshot.running
                  ? `${snapshot.processedCount}/${snapshot.totalDiscovered}`
                  : `${ledgerStats.syncedCount + ledgerStats.dedupedCount} synced`
              }
            />
          </View>

          {snapshot.running || snapshot.totalDiscovered > 0 ? (
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.max(4, Math.round(progressRatio * 100))}%` },
                ]}
              />
            </View>
          ) : null}

          {snapshot.running && snapshot.phase === 'uploading' && (snapshot.currentTotalBytes ?? 0) > 0 ? (
            <View style={styles.fileTransferBox}>
              <View style={styles.fileProgressTrack}>
                <View
                  style={[
                    styles.fileProgressFill,
                    { width: `${Math.max(2, Math.round(snapshot.currentProgress * 100))}%` },
                  ]}
                />
              </View>
              <Text style={styles.sampleText} numberOfLines={1}>
                {Math.round(snapshot.currentProgress * 100)}% ·{' '}
                {formatBytes(snapshot.currentBytesUploaded ?? 0)} /{' '}
                {formatBytes(snapshot.currentTotalBytes ?? 0)}
                {(snapshot.bytesPerSecond ?? 0) > 0
                  ? ` · ${formatSpeed(snapshot.bytesPerSecond ?? 0)}`
                  : ''}
                {snapshot.etaSeconds != null ? ` · ${formatEta(snapshot.etaSeconds)}` : ''}
              </Text>
              {snapshot.statusDetail ? (
                <Text style={styles.statText} numberOfLines={1}>
                  {snapshot.statusDetail}
                </Text>
              ) : null}
            </View>
          ) : null}

          {snapshot.lastError ? (
            <Banner tone="danger" icon="alert-circle-outline" message={snapshot.lastError} />
          ) : null}

          <View style={styles.statsStrip}>
            <Text style={styles.statText}>Uploaded: {snapshot.uploadedCount}</Text>
            <Text style={styles.statText}>Deduplicated: {snapshot.dedupedCount}</Text>
            <Text style={styles.statText}>Waiting Wi-Fi: {snapshot.icloudWaitingWifiCount}</Text>
          </View>

          <View style={styles.syncActionsRow}>
            {snapshot.running ? (
              <AppButton
                title="Cancel Sync"
                icon="stop-circle-outline"
                variant="danger"
                onPress={cancelSync}
                style={styles.flex}
              />
            ) : (
              <>
                <AppButton
                  title="Sync Originals Now"
                  icon="cloud-upload-outline"
                  onPress={() => {
                    void startSync();
                  }}
                  style={styles.flex}
                />
                <AppButton
                  title="Re-verify"
                  variant="subtle"
                  compact
                  onPress={() => {
                    void startSync({ forceReverify: true });
                  }}
                />
              </>
            )}
          </View>
        </Card>

        <SectionTitle title="Sync Preferences" />
        <Card style={styles.prefsCard}>
          <ToggleRow
            label="Automatic Background Backup"
            subtitle="Periodically backs up new photos when iOS allows background processing"
            value={settings.autoBackgroundSync}
            onValueChange={(value) => {
              void updateSettings({ autoBackgroundSync: value });
            }}
          />
          <ToggleRow
            label="Upload Only on Wi-Fi"
            subtitle="Pause full-resolution uploads on cellular connections"
            value={settings.wifiOnlySync}
            onValueChange={(value) => {
              void updateSettings({ wifiOnlySync: value });
            }}
          />
          <ToggleRow
            label="Download iCloud Originals on Cellular"
            subtitle="Offload iCloud originals only over Wi-Fi when disabled"
            value={settings.downloadICloudOverCellular}
            onValueChange={(value) => {
              void updateSettings({ downloadICloudOverCellular: value });
            }}
          />
          <ToggleRow
            label="Include Videos"
            subtitle="Back up full-resolution MOV and MP4 videos alongside photos"
            value={settings.includeVideos}
            onValueChange={(value) => {
              void updateSettings({ includeVideos: value });
            }}
          />
          <Pressable
            onPress={() => setFolderModalOpen(true)}
            style={styles.folderRow}
          >
            <View style={styles.flex}>
              <Text style={styles.toggleTitle}>NAS Backup Folder</Text>
              <Text style={styles.toggleSub}>{settings.destinationFolder}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
        </Card>

        <SectionTitle
          title="Recent Sync Activity"
          right={
            ledgerRecords.length > 0 ? (
              <Pressable
                onPress={() => {
                  Alert.alert(
                    'Reset Sync Ledger?',
                    'This clears local sync history and re-verifies hashes against your NAS on the next run.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Reset',
                        style: 'destructive',
                        onPress: () => {
                          void clearLedgerHistory();
                        },
                      },
                    ],
                  );
                }}
              >
                <Text style={styles.clearText}>Reset Ledger</Text>
              </Pressable>
            ) : undefined
          }
        />

        {ledgerRecords.length === 0 ? (
          <Card>
            <Text style={styles.emptyHistoryText}>
              No items processed yet. Tap “Sync Originals Now” to scan and back up your iPhone Photo Library.
            </Text>
          </Card>
        ) : (
          <Card style={styles.historyCard}>
            {ledgerRecords.slice(0, 20).map((rec, idx) => {
              const badge = ledgerStatusVisual(rec.status);
              return (
                <View
                  key={rec.asset_id}
                  style={[
                    styles.historyRow,
                    idx < Math.min(20, ledgerRecords.length) - 1 && styles.historyBorder,
                  ]}
                >
                  <View style={styles.flex}>
                    <View style={styles.historyTitleRow}>
                      <Text style={styles.historyName} numberOfLines={1}>
                        {rec.filename}
                      </Text>
                      {rec.was_in_icloud ? (
                        <Ionicons
                          name="cloud-download-outline"
                          size={14}
                          color={colors.accent}
                        />
                      ) : null}
                    </View>
                    <Text style={styles.historyMeta} numberOfLines={2}>
                      {formatBytes(rec.size_bytes)} • {formatDateTime(rec.synced_at)}
                      {rec.last_error ? `\n${rec.last_error}` : ''}
                    </Text>
                  </View>
                  <StatusBadge tone={badge.tone} label={badge.label} />
                </View>
              );
            })}
          </Card>
        )}
      </ScrollView>

      <TextPromptModal
        visible={folderModalOpen}
        title="NAS Backup Destination"
        message="Folder path inside your MyDrive account where photos and videos are organized."
        initialValue={settings.destinationFolder}
        placeholder="Photos/My iPhone"
        confirmLabel="Save"
        onCancel={() => setFolderModalOpen(false)}
        onSubmit={async (nextFolder) => {
          await updateSettings({ destinationFolder: nextFolder });
          setFolderModalOpen(false);
        }}
      />
    </SafeAreaView>
  );
}

function ToggleRow({
  label,
  subtitle,
  value,
  onValueChange,
}: {
  label: string;
  subtitle: string;
  value: boolean;
  onValueChange: (val: boolean) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleTextWrap}>
        <Text style={styles.toggleTitle}>{label}</Text>
        <Text style={styles.toggleSub}>{subtitle}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.lineStrong, true: colors.accent }}
        thumbColor={colors.white}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  header: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 2,
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  sectionCard: {
    gap: spacing.md,
  },
  icloudHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  icloudTitleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  icloudIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  refreshBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardHeading: {
    fontSize: 15.5,
    fontWeight: '700',
    color: colors.ink,
  },
  cardSub: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 2,
  },
  metricsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  metricBox: {
    flex: 1,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
  },
  metricHighlight: {
    backgroundColor: colors.accentTint,
    borderColor: colors.accentBorder,
  },
  metricValue: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.ink,
  },
  metricLabel: {
    fontSize: 11.5,
    color: colors.muted,
    fontWeight: '600',
    marginTop: 2,
  },
  sampleText: {
    fontSize: 12.5,
    color: colors.inkSoft,
    lineHeight: 18,
  },
  syncTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surfaceSubtle,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  fileTransferBox: {
    gap: spacing.xs,
  },
  fileProgressTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.surfaceSubtle,
    overflow: 'hidden',
  },
  fileProgressFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: '#25805f',
  },
  statsStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  statText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.inkSoft,
  },
  syncActionsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  prefsCard: {
    paddingVertical: spacing.xs,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  toggleTextWrap: {
    flex: 1,
  },
  toggleTitle: {
    fontSize: 14.5,
    fontWeight: '600',
    color: colors.ink,
  },
  toggleSub: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 2,
    lineHeight: 16,
  },
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
  },
  clearText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.danger,
  },
  emptyHistoryText: {
    fontSize: 13.5,
    color: colors.muted,
    lineHeight: 19,
  },
  historyCard: {
    paddingVertical: spacing.xs,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  historyBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  historyTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  historyName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
    flexShrink: 1,
  },
  historyMeta: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 2,
    lineHeight: 16,
  },
});
