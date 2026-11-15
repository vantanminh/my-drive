import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { File } from 'expo-file-system';
import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';
import { VideoView, useVideoPlayer } from 'expo-video';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

import { downloadToLocalFile } from '../../modules/mydrive-media-sync/src';
import { ShareLinkModal } from '../components/ShareLinkModal';
import { AppButton, Banner, Card, KeyValueRow } from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import {
  formatBytes,
  formatDateTime,
  resolveViewerKind,
} from '../services/format';
import { colors, radius, spacing } from '../theme/tokens';
import type { EntryDetails } from '../types/mydrive';

type Props = NativeStackScreenProps<RootStackParamList, 'FileViewer'>;

const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;

function VideoBody({ uri, width, height }: { uri: string; width: number; height: number }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });
  return (
    <View style={styles.videoWrap}>
      <VideoView
        player={player}
        style={{ width, height: Math.min(360, height * 0.52) }}
        nativeControls
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
      />
    </View>
  );
}

export function FileViewerScreen({ navigation, route }: Props) {
  const { entry } = route.params;
  const { client } = useAuth();
  const { width, height } = useWindowDimensions();

  const kind = resolveViewerKind(entry.name, entry.mime_detected, entry.category);
  const [details, setDetails] = useState<EntryDetails | null>(null);
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textTruncated, setTextTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState(false);
  const [shareLinkOpen, setShareLinkOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setErrorMsg(null);

    try {
      void client
        .getEntryDetails(entry.id)
        .then((res) => setDetails(res))
        .catch(() => {});

      if (kind === 'image' || kind === 'video') {
        setLoading(false);
        return;
      }

      if (kind === 'pdf' || kind === 'office') {
        try {
          const previewName =
            kind === 'office' ? `${entry.name}.pdf` : entry.name;
          const dl = await downloadToLocalFile(
            client.previewUrl(entry.id),
            previewName,
          );
          setLocalUri(dl.localUri);
        } catch {
          const fallbackDl = await downloadToLocalFile(
            client.downloadUrl(entry.id),
            entry.name,
          );
          setLocalUri(fallbackDl.localUri);
        }
        return;
      }

      if (kind === 'text') {
        const dl = await downloadToLocalFile(
          client.downloadUrl(entry.id),
          entry.name,
        );
        setLocalUri(dl.localUri);
        const content = await new File(dl.localUri).text();
        if (content.length > MAX_TEXT_PREVIEW_BYTES) {
          setTextContent(content.slice(0, MAX_TEXT_PREVIEW_BYTES));
          setTextTruncated(true);
        } else {
          setTextContent(content);
          setTextTruncated(false);
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, entry.id, entry.name, kind]);

  useEffect(() => {
    navigation.setOptions({ title: entry.name });
    void loadPreview();
  }, [navigation, entry.name, loadPreview]);

  const ensureDownloadedOriginal = async (): Promise<string> => {
    if (!client) throw new Error('Not connected to NAS.');
    const dl = await downloadToLocalFile(
      client.downloadUrl(entry.id),
      entry.name,
    );
    return dl.localUri;
  };

  const sendOriginalFile = async () => {
    if (busyAction) return;
    setBusyAction(true);
    try {
      const uri = await ensureDownloadedOriginal();
      await Sharing.shareAsync(uri, {
        mimeType: entry.mime_detected ?? undefined,
        dialogTitle: entry.name,
      });
    } catch (err) {
      Alert.alert('Share Failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(false);
    }
  };

  const handleShare = () => {
    if (busyAction) return;
    Alert.alert(entry.name, 'How would you like to share this file?', [
      {
        text: 'Create Public Link',
        onPress: () => setShareLinkOpen(true),
      },
      {
        text: 'Download & Send File',
        onPress: () => void sendOriginalFile(),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleQuickLook = async () => {
    if (busyAction) return;
    setBusyAction(true);
    try {
      const targetUri = localUri ?? (await ensureDownloadedOriginal());
      const file = new File(targetUri);
      const can = await File.canPreview(file);
      if (can) {
        await File.preview(file, {
          title: entry.name,
          mimeType: entry.mime_detected ?? undefined,
        });
      } else {
        await Sharing.shareAsync(targetUri, {
          mimeType: entry.mime_detected ?? undefined,
          dialogTitle: entry.name,
        });
      }
    } catch (err) {
      Alert.alert('Preview Failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(false);
    }
  };

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerRight}>
          <Pressable
            onPress={() => void handleQuickLook()}
            hitSlop={8}
            style={styles.headerBtn}
          >
            <Ionicons name="eye-outline" size={21} color={colors.accent} />
          </Pressable>
          <Pressable
            onPress={() => void handleShare()}
            hitSlop={8}
            style={styles.headerBtn}
          >
            <Ionicons name="share-outline" size={21} color={colors.accent} />
          </Pressable>
        </View>
      ),
    });
  });

  if (!client) return null;

  const renderPreview = () => {
    if (loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.loadingText}>Loading preview from NAS…</Text>
        </View>
      );
    }

    if (errorMsg) {
      return (
        <ScrollView contentContainerStyle={styles.paddedContent}>
          <Banner
            tone="danger"
            icon="alert-circle-outline"
            title="Could Not Load Inline Preview"
            message={errorMsg}
          />
          <AppButton
            title="Share / Download File"
            icon="share-outline"
            loading={busyAction}
            onPress={() => handleShare()}
          />
        </ScrollView>
      );
    }

    if (kind === 'image') {
      return (
        <ScrollView
          style={styles.darkSurface}
          contentContainerStyle={styles.imageCenter}
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
        >
          <Image
            source={{ uri: client.previewUrl(entry.id) }}
            style={{ width, height: height * 0.8 }}
            contentFit="contain"
          />
        </ScrollView>
      );
    }

    if (kind === 'video') {
      return (
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.paddedContent}
        >
          <VideoBody uri={client.previewUrl(entry.id)} width={width - spacing.lg * 2} height={height} />
          <DetailsCard entry={entry} details={details} />
        </ScrollView>
      );
    }

    if ((kind === 'pdf' || kind === 'office') && localUri) {
      const readDir = localUri.slice(0, localUri.lastIndexOf('/') + 1);
      return (
        <View style={styles.flex}>
          <WebView
            source={{ uri: localUri }}
            allowingReadAccessToURL={readDir}
            originWhitelist={['*']}
            style={styles.flex}
          />
          <View style={styles.footerBar}>
            <AppButton
              title="QuickLook"
              icon="eye-outline"
              variant="secondary"
              compact
              loading={busyAction}
              onPress={() => void handleQuickLook()}
              style={styles.footerBtn}
            />
            <AppButton
              title="Share / Link"
              icon="share-outline"
              variant="primary"
              compact
              loading={busyAction}
              onPress={() => handleShare()}
              style={styles.footerBtn}
            />
          </View>
        </View>
      );
    }

    if (kind === 'text' && textContent !== null) {
      return (
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.paddedContent}
        >
          {textTruncated ? (
            <Banner
              tone="warning"
              icon="document-text-outline"
              message="Showing the first 512 KB. Tap Share to open the complete file."
            />
          ) : null}
          <Card>
            <Text style={styles.monoText} selectable>
              {textContent || '(Empty file)'}
            </Text>
          </Card>
          <DetailsCard entry={entry} details={details} />
        </ScrollView>
      );
    }

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.paddedContent}
      >
        <Card style={styles.binaryHero}>
          <View style={styles.binaryIcon}>
            <Ionicons name="document-outline" size={36} color={colors.accent} />
          </View>
          <Text style={styles.binaryName}>{entry.name}</Text>
          <Text style={styles.binarySub}>
            {formatBytes(entry.size_bytes)} • {entry.mime_detected ?? 'Binary File'}
          </Text>
          <View style={styles.binaryActions}>
            <AppButton
              title="Open in QuickLook"
              icon="eye-outline"
              loading={busyAction}
              onPress={() => void handleQuickLook()}
            />
            <AppButton
              title="Share / Public Link"
              icon="share-outline"
              variant="secondary"
              loading={busyAction}
              onPress={() => handleShare()}
            />
          </View>
        </Card>
        <DetailsCard entry={entry} details={details} />
      </ScrollView>
    );
  };

  return (
    <View style={styles.flex}>
      {renderPreview()}
      <ShareLinkModal
        visible={shareLinkOpen}
        subject={{
          resourceType: 'file',
          resourceId: entry.id,
          name: entry.name,
        }}
        onClose={() => setShareLinkOpen(false)}
      />
    </View>
  );
}

function DetailsCard({
  entry,
  details,
}: {
  entry: RootStackParamList['FileViewer']['entry'];
  details: EntryDetails | null;
}) {
  return (
    <Card>
      <KeyValueRow label="Filename" value={entry.name} />
      <KeyValueRow
        label="Size"
        value={formatBytes(details?.size_bytes ?? entry.size_bytes)}
      />
      <KeyValueRow
        label="Type"
        value={details?.mime_type ?? entry.mime_detected ?? entry.category ?? 'File'}
      />
      <KeyValueRow
        label="Modified"
        value={formatDateTime(details?.updated_at ?? entry.updated_at)}
        last={!details?.location}
      />
      {details?.location ? (
        <KeyValueRow label="Location" value={details.location} last />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  darkSurface: {
    flex: 1,
    backgroundColor: colors.viewerBg,
  },
  imageCenter: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  loadingText: {
    fontSize: 14,
    color: colors.muted,
    fontWeight: '500',
  },
  paddedContent: {
    padding: spacing.lg,
    gap: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  videoWrap: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.viewerBg,
  },
  monoText: {
    fontFamily: 'Courier',
    fontSize: 12.5,
    lineHeight: 19,
    color: colors.ink,
  },
  footerBar: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  footerBtn: {
    flex: 1,
  },
  binaryHero: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  binaryIcon: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  binaryName: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
  },
  binarySub: {
    fontSize: 13.5,
    color: colors.muted,
    textAlign: 'center',
  },
  binaryActions: {
    width: '100%',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  headerBtn: {
    padding: 4,
  },
});
