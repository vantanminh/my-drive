import React, { useMemo, useState } from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import {
  AppButton,
  Banner,
  Card,
  KeyValueRow,
  StatusBadge,
  TextField,
} from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import { normalizeServerUrl } from '../services/serverUrl';
import { colors, radius, spacing } from '../theme/tokens';
import type { ServerCapabilities } from '../types/mydrive';

const QUICK_CHIPS = [
  { label: 'https://', value: 'https://' },
  { label: 'http://', value: 'http://' },
  { label: '.local:8080', value: 'mynas.local:8080' },
  { label: '192.168.x.x:8080', value: '192.168.1.100:8080' },
];

export function ServerSetupScreen() {
  const { serverUrl, connectServer, confirmServerConnection } = useAuth();
  const [rawUrl, setRawUrl] = useState(serverUrl ?? '');
  const [probing, setProbing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [verifiedProbe, setVerifiedProbe] = useState<{
    normalizedUrl: string;
    isInsecureHttp: boolean;
    capabilities: ServerCapabilities | null;
  } | null>(null);

  const livePreview = useMemo(() => {
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;
    try {
      return normalizeServerUrl(trimmed);
    } catch {
      return null;
    }
  }, [rawUrl]);

  const applyQuickChip = (value: string) => {
    setVerifiedProbe(null);
    setErrorMsg(null);
    if (value === 'https://' || value === 'http://') {
      const stripped = rawUrl.trim().replace(/^https?:\/\//i, '');
      setRawUrl(`${value}${stripped}`);
      return;
    }
    setRawUrl(value);
  };

  const handleProbeAndConnect = async () => {
    if (!rawUrl.trim()) {
      setErrorMsg('Enter your MyDrive NAS domain, Tailscale IP, or LAN address.');
      return;
    }
    setErrorMsg(null);
    setProbing(true);

    try {
      const result = await connectServer(rawUrl);
      setVerifiedProbe(result);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (result.isInsecureHttp) {
        Alert.alert(
          'Connect over HTTP?',
          `${result.normalizedUrl} does not use HTTPS encryption. Continue only on a trusted LAN, VPN, or Tailscale network.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Trust & Continue',
              onPress: () => {
                void confirmServerConnection(
                  result.normalizedUrl,
                  true,
                  result.capabilities,
                );
              },
            },
          ],
        );
        return;
      }

      await confirmServerConnection(
        result.normalizedUrl,
        false,
        result.capabilities,
      );
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setVerifiedProbe(null);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <Image
              source={require('../../assets/icon.png')}
              style={styles.logo}
            />
            <Text style={styles.title}>Connect Your MyDrive NAS</Text>
            <Text style={styles.subtitle}>
              Enter the exact address where your self-hosted MyDrive server is running.
            </Text>
          </View>

          <Card style={styles.card}>
            <TextField
              label="Server URL"
              value={rawUrl}
              onChangeText={(text) => {
                setRawUrl(text);
                setErrorMsg(null);
                setVerifiedProbe(null);
              }}
              placeholder="nas.yourdomain.com or 192.168.1.50:8080"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={handleProbeAndConnect}
              error={errorMsg}
              helper="Supports reverse-proxy HTTPS domains, Tailscale IPs (100.x), and LAN HTTP servers."
              rightAccessory={
                rawUrl ? (
                  <Pressable
                    onPress={() => {
                      setRawUrl('');
                      setErrorMsg(null);
                      setVerifiedProbe(null);
                    }}
                    hitSlop={10}
                  >
                    <Ionicons name="close-circle" size={18} color={colors.muted} />
                  </Pressable>
                ) : null
              }
            />

            {livePreview ? (
              <View style={styles.previewBox}>
                <View style={styles.previewRow}>
                  <StatusBadge
                    tone={livePreview.isInsecureHttp ? 'warning' : 'success'}
                    icon={livePreview.isInsecureHttp ? 'warning-outline' : 'lock-closed-outline'}
                    label={livePreview.isInsecureHttp ? 'HTTP (LAN / VPN)' : 'HTTPS TLS'}
                  />
                  {livePreview.isLocalNetworkHost ? (
                    <StatusBadge
                      tone="neutral"
                      icon="wifi-outline"
                      label="Local / Tailscale"
                    />
                  ) : null}
                </View>
                <Text style={styles.previewUrl} numberOfLines={1}>
                  {livePreview.url}
                </Text>
              </View>
            ) : null}

            <View style={styles.chipsRow}>
              {QUICK_CHIPS.map((chip) => (
                <Pressable
                  key={chip.label}
                  onPress={() => applyQuickChip(chip.value)}
                  style={({ pressed }) => [
                    styles.chip,
                    pressed && styles.chipPressed,
                  ]}
                >
                  <Text style={styles.chipText}>{chip.label}</Text>
                </Pressable>
              ))}
            </View>

            <AppButton
              title={probing ? 'Testing NAS Connection…' : 'Verify & Connect'}
              icon="server-outline"
              onPress={handleProbeAndConnect}
              loading={probing}
              style={styles.connectButton}
            />
          </Card>

          {verifiedProbe?.capabilities ? (
            <Card style={styles.probeCard}>
              <View style={styles.probeHeader}>
                <StatusBadge
                  tone="success"
                  icon="checkmark-circle"
                  label="Server Verified"
                />
                <Text style={styles.probeVersion}>
                  v{verifiedProbe.capabilities.serverVersion}
                </Text>
              </View>
              <KeyValueRow label="Endpoint" value={verifiedProbe.normalizedUrl} />
              <KeyValueRow
                label="Chunked Resumable Upload"
                value={verifiedProbe.capabilities.features.resumableUpload ? 'Supported' : 'Standard'}
              />
              <KeyValueRow
                label="Deduplication"
                value={verifiedProbe.capabilities.features.deduplication ? 'SHA-256 Enabled' : 'Disabled'}
                last
              />
            </Card>
          ) : null}

          <Banner
            tone="accent"
            icon="cloud-download-outline"
            title="Full-Resolution iCloud Backup"
            message="MyDrive inspects your iPhone Photo Library, automatically detects photos offloaded to iCloud, and downloads original files before syncing to your NAS."
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
  },
  hero: {
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  },
  logo: {
    width: 76,
    height: 76,
    borderRadius: 20,
    marginBottom: spacing.lg,
  },
  title: {
    fontSize: 25,
    fontWeight: '800',
    color: colors.ink,
    textAlign: 'center',
    letterSpacing: -0.4,
  },
  subtitle: {
    fontSize: 15,
    color: colors.inkSoft,
    textAlign: 'center',
    lineHeight: 22,
    marginTop: spacing.xs + 2,
  },
  card: {
    gap: spacing.sm,
  },
  previewBox: {
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
    gap: spacing.xs + 2,
    marginBottom: spacing.xs,
  },
  previewRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
  },
  previewUrl: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.ink,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
    marginBottom: spacing.xs,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.line,
  },
  chipPressed: {
    backgroundColor: colors.surfacePressed,
  },
  chipText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.inkSoft,
  },
  connectButton: {
    marginTop: spacing.xs,
  },
  probeCard: {
    gap: spacing.xs,
  },
  probeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  probeVersion: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.muted,
  },
});
