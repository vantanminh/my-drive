import React, { useState } from 'react';
import {
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
  StatusBadge,
  TextField,
} from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import { colors, radius, spacing } from '../theme/tokens';

export function LoginScreen() {
  const {
    serverUrl,
    lastEmail,
    capabilities,
    sessionNotice,
    clearSessionNotice,
    switchServer,
    login,
  } = useAuth();

  const [email, setEmail] = useState(lastEmail ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      setErrorMsg('Enter both your email address and password.');
      return;
    }
    setErrorMsg(null);
    clearSessionNotice();
    setSubmitting(true);

    try {
      await login(email.trim(), password);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const isHttps = serverUrl?.startsWith('https://') ?? false;

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
            <Text style={styles.title}>Sign In to MyDrive</Text>
            <Text style={styles.subtitle}>
              Access your personal photos, albums, files, and automated NAS backup.
            </Text>
          </View>

          <Card style={styles.serverPillCard}>
            <View style={styles.serverRow}>
              <View style={styles.serverMeta}>
                <View style={styles.serverTopRow}>
                  <StatusBadge
                    tone={isHttps ? 'success' : 'warning'}
                    icon={isHttps ? 'lock-closed-outline' : 'wifi-outline'}
                    label={isHttps ? 'HTTPS Connected' : 'HTTP LAN'}
                  />
                  {capabilities?.serverVersion ? (
                    <Text style={styles.serverVersion}>
                      v{capabilities.serverVersion}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.serverUrlText} numberOfLines={1}>
                  {serverUrl}
                </Text>
              </View>
              <Pressable
                onPress={() => {
                  void switchServer();
                }}
                style={({ pressed }) => [
                  styles.switchBtn,
                  pressed && styles.switchBtnPressed,
                ]}
              >
                <Text style={styles.switchBtnText}>Change</Text>
              </Pressable>
            </View>
          </Card>

          {sessionNotice ? (
            <Banner
              tone="warning"
              icon="time-outline"
              message={sessionNotice}
            />
          ) : null}

          {errorMsg ? (
            <Banner
              tone="danger"
              icon="alert-circle-outline"
              message={errorMsg}
            />
          ) : null}

          <Card>
            <TextField
              label="Email"
              value={email}
              onChangeText={(text) => {
                setEmail(text);
                setErrorMsg(null);
              }}
              placeholder="owner@example.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              returnKeyType="next"
            />

            <TextField
              label="Password"
              value={password}
              onChangeText={(text) => {
                setPassword(text);
                setErrorMsg(null);
              }}
              placeholder="Enter password"
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              autoComplete="password"
              returnKeyType="done"
              onSubmitEditing={handleLogin}
              rightAccessory={
                <Pressable
                  onPress={() => setShowPassword((prev) => !prev)}
                  hitSlop={10}
                >
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={20}
                    color={colors.muted}
                  />
                </Pressable>
              }
            />

            <AppButton
              title={submitting ? 'Signing In…' : 'Sign In'}
              icon="log-in-outline"
              onPress={handleLogin}
              loading={submitting}
              style={styles.submitBtn}
            />
          </Card>
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
    width: 70,
    height: 70,
    borderRadius: 18,
    marginBottom: spacing.md,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.4,
  },
  subtitle: {
    fontSize: 14.5,
    color: colors.inkSoft,
    textAlign: 'center',
    lineHeight: 20,
    marginTop: spacing.xs + 2,
  },
  serverPillCard: {
    paddingVertical: spacing.md,
  },
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  serverMeta: {
    flex: 1,
    gap: spacing.xs + 2,
  },
  serverTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  serverVersion: {
    fontSize: 12,
    color: colors.muted,
    fontWeight: '600',
  },
  serverUrlText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.ink,
  },
  switchBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.line,
  },
  switchBtnPressed: {
    backgroundColor: colors.surfacePressed,
  },
  switchBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent,
  },
  submitBtn: {
    marginTop: spacing.xs,
  },
});
