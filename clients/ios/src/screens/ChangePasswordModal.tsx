import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';

import { AppButton, Banner, Card, TextField } from '../components/UiPrimitives';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import { colors, spacing } from '../theme/tokens';

type Props = NativeStackScreenProps<RootStackParamList, 'ChangePassword'>;

export function ChangePasswordModal({ navigation, route }: Props) {
  const { user, changePassword, logout } = useAuth();
  const required = Boolean(route.params?.required || user?.must_change_password);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSave = async () => {
    if (!currentPassword || !newPassword) {
      setErrorMsg('Enter your current password and choose a new password.');
      return;
    }
    if (newPassword.length < 8) {
      setErrorMsg('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMsg('New passwords do not match.');
      return;
    }

    setErrorMsg(null);
    setSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (navigation.canGoBack()) {
        navigation.goBack();
      }
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text style={styles.title}>
              {required ? 'Update Temporary Password' : 'Change Password'}
            </Text>
            <Text style={styles.subtitle}>
              {required
                ? 'Your administrator requires a new password before continuing.'
                : 'Choose a strong password for your MyDrive account.'}
            </Text>
          </View>

          {errorMsg ? (
            <Banner tone="danger" icon="alert-circle-outline" message={errorMsg} />
          ) : null}

          <Card>
            <TextField
              label="Current Password"
              value={currentPassword}
              onChangeText={setCurrentPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextField
              label="New Password"
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              helper="Minimum 8 characters."
            />
            <TextField
              label="Confirm New Password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleSave}
            />

            <AppButton
              title={saving ? 'Updating Password…' : 'Save New Password'}
              icon="key-outline"
              onPress={handleSave}
              loading={saving}
            />

            {required ? (
              <AppButton
                title="Sign Out Instead"
                variant="ghost"
                onPress={() => {
                  void logout();
                }}
                style={styles.secondaryBtn}
              />
            ) : (
              <AppButton
                title="Cancel"
                variant="subtle"
                onPress={() => navigation.goBack()}
                style={styles.secondaryBtn}
              />
            )}
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
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  header: {
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.ink,
  },
  subtitle: {
    fontSize: 14.5,
    color: colors.inkSoft,
    lineHeight: 20,
  },
  secondaryBtn: {
    marginTop: spacing.sm,
  },
});
