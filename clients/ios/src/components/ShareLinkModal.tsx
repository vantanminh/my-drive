import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../context/AuthContext';
import {
  buildPublicShareUrl,
  formatExpiryCountdown,
  isShareActive,
} from '../services/shareLinks';
import {
  loadRememberedShareUrls,
  rememberShareUrl,
} from '../services/secureStorage';
import { colors, radius, spacing } from '../theme/tokens';
import type {
  CreatedShare,
  ShareResourceType,
  ShareSummary,
} from '../types/mydrive';
import { AppButton, Banner, StatusBadge } from './UiPrimitives';

export interface ShareTargetSubject {
  resourceType: ShareResourceType;
  resourceId: string;
  name: string;
}

type ExpiryOption = '1d' | '7d' | '30d' | 'never';
type DownloadLimitOption = 'unlimited' | '1' | '5' | '20' | '50';

const EXPIRY_OPTIONS: Array<{ key: ExpiryOption; label: string; hours: number | null }> = [
  { key: '1d', label: '24 Hours', hours: 24 },
  { key: '7d', label: '7 Days', hours: 24 * 7 },
  { key: '30d', label: '30 Days', hours: 24 * 30 },
  { key: 'never', label: 'Never', hours: null },
];

const DOWNLOAD_LIMIT_OPTIONS: Array<{ key: DownloadLimitOption; label: string; count: number | null }> = [
  { key: 'unlimited', label: 'Unlimited', count: null },
  { key: '1', label: '1', count: 1 },
  { key: '5', label: '5', count: 5 },
  { key: '20', label: '20', count: 20 },
  { key: '50', label: '50', count: 50 },
];

function generatePassphrase(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const group = () =>
    Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

export function ShareLinkModal({
  visible,
  subject,
  onClose,
  onCreated,
}: {
  visible: boolean;
  subject: ShareTargetSubject | null;
  onClose: () => void;
  onCreated?: (created: CreatedShare, fullUrl: string) => void;
}) {
  const { client, serverUrl } = useAuth();

  const [expiry, setExpiry] = useState<ExpiryOption>('7d');
  const [allowDownload, setAllowDownload] = useState(true);
  const [downloadLimit, setDownloadLimit] = useState<DownloadLimitOption>('unlimited');
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [existingShares, setExistingShares] = useState<ShareSummary[]>([]);
  const [cachedUrls, setCachedUrls] = useState<Record<string, string>>({});
  const [loadingExisting, setLoadingExisting] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [createdResult, setCreatedResult] = useState<{
    share: CreatedShare;
    fullUrl: string;
    passwordUsed: string | null;
  } | null>(null);

  const loadExistingForSubject = useCallback(async () => {
    if (!client || !serverUrl || !subject) return;
    setLoadingExisting(true);
    try {
      const [page, urls] = await Promise.all([
        client.listShares(0, 50),
        loadRememberedShareUrls(serverUrl),
      ]);
      const matching = page.shares.filter(
        (share) =>
          share.resource_id === subject.resourceId &&
          share.resource_type === subject.resourceType &&
          isShareActive(share),
      );
      setExistingShares(matching);
      setCachedUrls(urls);
    } catch {
      // Optional smart hint; ignore transient fetch failures.
    } finally {
      setLoadingExisting(false);
    }
  }, [client, serverUrl, subject]);

  useEffect(() => {
    if (visible && subject) {
      setExpiry('7d');
      setAllowDownload(true);
      setDownloadLimit('unlimited');
      setUsePassword(false);
      setPassword('');
      setShowPassword(false);
      setErrorMsg(null);
      setCreatedResult(null);
      setExistingShares([]);
      void loadExistingForSubject();
    }
  }, [visible, subject, loadExistingForSubject]);

  const reusableShare = useMemo(
    () => existingShares.find((item) => Boolean(cachedUrls[item.id])) ?? null,
    [existingShares, cachedUrls],
  );

  const handleNativeShare = async (url: string, label: string, pwd?: string | null) => {
    const message = pwd
      ? `${label}\n${url}\nPassword: ${pwd}`
      : `${label}\n${url}`;
    await Share.share({
      title: label,
      message,
      url,
    });
  };

  const handleCreate = async () => {
    if (!client || !serverUrl || !subject || submitting) return;
    setErrorMsg(null);

    const trimmedPassword = usePassword ? password : '';
    if (usePassword && (trimmedPassword.length < 8 || trimmedPassword.length > 128)) {
      setErrorMsg('Password must be between 8 and 128 characters.');
      return;
    }

    const expiryConfig = EXPIRY_OPTIONS.find((item) => item.key === expiry);
    const expiresAt =
      expiryConfig?.hours != null
        ? new Date(Date.now() + expiryConfig.hours * 60 * 60 * 1000).toISOString()
        : null;
    const limitConfig = DOWNLOAD_LIMIT_OPTIONS.find((item) => item.key === downloadLimit);

    setSubmitting(true);
    try {
      const created = await client.createShare({
        resource_type: subject.resourceType,
        resource_id: subject.resourceId,
        expires_at: expiresAt,
        password: trimmedPassword || null,
        allow_download: allowDownload,
        max_downloads: limitConfig?.count ?? null,
      });
      const fullUrl = buildPublicShareUrl(serverUrl, created.share_url);
      await rememberShareUrl(serverUrl, created.id, fullUrl);
      setCreatedResult({
        share: created,
        fullUrl,
        passwordUsed: trimmedPassword || null,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onCreated?.(created, fullUrl);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!subject) return null;

  const resourceIcon: keyof typeof Ionicons.glyphMap =
    subject.resourceType === 'album'
      ? 'albums-outline'
      : subject.resourceType === 'folder'
        ? 'folder-outline'
        : 'document-outline';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <View style={styles.subjectIcon}>
              <Ionicons name={resourceIcon} size={20} color={colors.accent} />
            </View>
            <View style={styles.flex}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {createdResult ? 'Public Link Ready' : 'Share NAS Link'}
              </Text>
              <Text style={styles.sheetSubtitle} numberOfLines={1}>
                {subject.name} • {subject.resourceType}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scrollBody}
            keyboardShouldPersistTaps="handled"
          >
            {createdResult ? (
              <>
                <Banner
                  tone="success"
                  icon="checkmark-circle-outline"
                  title="Link created & saved to Shared tab"
                  message={
                    createdResult.passwordUsed
                      ? 'Anyone with this link needs the password below to open it.'
                      : 'Anyone with this link can view this shared item from your NAS.'
                  }
                />

                <View style={styles.urlBox}>
                  <Text style={styles.urlLabel}>PUBLIC LINK</Text>
                  <Text style={styles.urlText} selectable>
                    {createdResult.fullUrl}
                  </Text>
                </View>

                {createdResult.passwordUsed ? (
                  <View style={styles.urlBox}>
                    <Text style={styles.urlLabel}>PASSWORD (SHARE SEPARATELY)</Text>
                    <Text style={styles.passwordValue} selectable>
                      {createdResult.passwordUsed}
                    </Text>
                  </View>
                ) : null}

                <View style={styles.summaryBadges}>
                  <StatusBadge
                    tone="accent"
                    icon="time-outline"
                    label={formatExpiryCountdown(createdResult.share.expires_at)}
                  />
                  <StatusBadge
                    tone={createdResult.share.allow_download ? 'success' : 'neutral'}
                    icon={createdResult.share.allow_download ? 'download-outline' : 'eye-outline'}
                    label={createdResult.share.allow_download ? 'Downloads On' : 'View Only'}
                  />
                  {createdResult.share.max_downloads != null ? (
                    <StatusBadge
                      tone="neutral"
                      label={`Max ${createdResult.share.max_downloads} downloads`}
                    />
                  ) : null}
                </View>

                <AppButton
                  title="Share / Copy Link"
                  icon="share-outline"
                  onPress={() => {
                    void handleNativeShare(
                      createdResult.fullUrl,
                      subject.name,
                      createdResult.passwordUsed,
                    );
                  }}
                />
                {createdResult.passwordUsed ? (
                  <AppButton
                    title="Share Link Only (No Password)"
                    icon="link-outline"
                    variant="secondary"
                    compact
                    onPress={() => {
                      void handleNativeShare(createdResult.fullUrl, subject.name, null);
                    }}
                  />
                ) : null}
                <AppButton
                  title="Open Link in Browser"
                  icon="open-outline"
                  variant="subtle"
                  compact
                  onPress={() => {
                    void Linking.openURL(createdResult.fullUrl);
                  }}
                />
              </>
            ) : (
              <>
                {loadingExisting ? (
                  <View style={styles.hintRow}>
                    <ActivityIndicator size="small" color={colors.accent} />
                    <Text style={styles.hintText}>Checking existing links for this item…</Text>
                  </View>
                ) : existingShares.length > 0 ? (
                  <Banner
                    tone="accent"
                    icon="link-outline"
                    title={`${existingShares.length} active ${existingShares.length === 1 ? 'link exists' : 'links exist'} already`}
                    message={
                      reusableShare
                        ? `You can re-share the active link created on this phone (${formatExpiryCountdown(reusableShare.expires_at)}), or create a new one below.`
                        : `Active links already exist in the Shared tab (${formatExpiryCountdown(existingShares[0].expires_at)}).`
                    }
                    actionLabel={reusableShare ? 'Re-share Existing Link' : undefined}
                    onAction={
                      reusableShare
                        ? () => {
                            const url = cachedUrls[reusableShare.id];
                            if (url) {
                              void handleNativeShare(url, subject.name);
                            }
                          }
                        : undefined
                    }
                  />
                ) : null}

                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>Link Expiration</Text>
                  <View style={styles.pillsRow}>
                    {EXPIRY_OPTIONS.map((option) => (
                      <Pressable
                        key={option.key}
                        onPress={() => setExpiry(option.key)}
                        style={[
                          styles.pill,
                          expiry === option.key && styles.pillActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.pillText,
                            expiry === option.key && styles.pillTextActive,
                          ]}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                <View style={styles.switchCard}>
                  <View style={styles.flex}>
                    <Text style={styles.switchTitle}>Allow Downloads</Text>
                    <Text style={styles.switchSub}>
                      When disabled, recipients can only preview in browser
                    </Text>
                  </View>
                  <Switch
                    value={allowDownload}
                    onValueChange={setAllowDownload}
                    trackColor={{ false: colors.lineStrong, true: colors.accent }}
                    thumbColor={colors.white}
                  />
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>Download Limit</Text>
                  <View style={styles.pillsRow}>
                    {DOWNLOAD_LIMIT_OPTIONS.map((option) => (
                      <Pressable
                        key={option.key}
                        onPress={() => setDownloadLimit(option.key)}
                        style={[
                          styles.pill,
                          downloadLimit === option.key && styles.pillActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.pillText,
                            downloadLimit === option.key && styles.pillTextActive,
                          ]}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                <View style={styles.switchCard}>
                  <View style={styles.flex}>
                    <Text style={styles.switchTitle}>Password Protection</Text>
                    <Text style={styles.switchSub}>
                      Require an 8+ character password before viewing
                    </Text>
                  </View>
                  <Switch
                    value={usePassword}
                    onValueChange={(next) => {
                      setUsePassword(next);
                      if (next && !password) {
                        setPassword(generatePassphrase());
                        setShowPassword(true);
                      }
                    }}
                    trackColor={{ false: colors.lineStrong, true: colors.accent }}
                    thumbColor={colors.white}
                  />
                </View>

                {usePassword ? (
                  <View style={styles.passwordBox}>
                    <TextInput
                      value={password}
                      onChangeText={(text) => {
                        setPassword(text);
                        setErrorMsg(null);
                      }}
                      placeholder="Enter 8+ character password"
                      placeholderTextColor={colors.muted}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={styles.passwordInput}
                    />
                    <Pressable
                      onPress={() => setShowPassword((prev) => !prev)}
                      hitSlop={8}
                      style={styles.passwordIconBtn}
                    >
                      <Ionicons
                        name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                        size={18}
                        color={colors.muted}
                      />
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setPassword(generatePassphrase());
                        setShowPassword(true);
                      }}
                      style={styles.generateBtn}
                    >
                      <Text style={styles.generateText}>Generate</Text>
                    </Pressable>
                  </View>
                ) : null}

                {errorMsg ? (
                  <Banner tone="danger" icon="alert-circle-outline" message={errorMsg} />
                ) : null}

                <AppButton
                  title="Create Public Share Link"
                  icon="link-outline"
                  loading={submitting}
                  onPress={() => {
                    void handleCreate();
                  }}
                />
              </>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
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
    maxHeight: '88%',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  flex: {
    flex: 1,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  subjectIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.ink,
  },
  sheetSubtitle: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 2,
    textTransform: 'capitalize',
  },
  closeBtn: {
    padding: 4,
  },
  scrollBody: {
    paddingTop: spacing.md,
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
  hintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  hintText: {
    fontSize: 13,
    color: colors.muted,
  },
  section: {
    gap: spacing.xs + 2,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.inkSoft,
  },
  pillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  pill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surfaceSubtle,
  },
  pillActive: {
    backgroundColor: colors.accentTint,
    borderColor: colors.accent,
  },
  pillText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.inkSoft,
  },
  pillTextActive: {
    color: colors.accentDark,
    fontWeight: '700',
  },
  switchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.line,
  },
  switchTitle: {
    fontSize: 14.5,
    fontWeight: '700',
    color: colors.ink,
  },
  switchSub: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 2,
  },
  passwordBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    height: 46,
  },
  passwordInput: {
    flex: 1,
    fontSize: 14.5,
    color: colors.ink,
  },
  passwordIconBtn: {
    padding: 4,
  },
  generateBtn: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accentTint,
  },
  generateText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.accentDark,
  },
  urlBox: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    gap: 4,
  },
  urlLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.accentDark,
    letterSpacing: 0.5,
  },
  urlText: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.ink,
  },
  passwordValue: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: 'Courier',
  },
  summaryBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
  },
});
