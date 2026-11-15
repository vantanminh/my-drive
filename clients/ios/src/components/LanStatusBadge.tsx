import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../context/AuthContext';
import { colors, radius, spacing } from '../theme/tokens';
import type { LanConnectionMode } from '../types/mydrive';

function badgeMeta(mode: LanConnectionMode, latencyMs: number | null, compact: boolean) {
  switch (mode) {
    case 'lan':
      return {
        label: latencyMs != null ? `LAN • ${latencyMs}ms` : 'LAN Direct',
        icon: 'flash' as keyof typeof Ionicons.glyphMap,
        bg: colors.successTint,
        fg: colors.success,
        border: colors.accentBorder,
      };
    case 'checking':
      return {
        label: compact ? 'Checking' : 'Checking LAN',
        icon: 'sync-outline' as keyof typeof Ionicons.glyphMap,
        bg: colors.warningTint,
        fg: colors.warning,
        border: colors.warningBorder,
      };
    case 'offline':
      return {
        label: 'Offline',
        icon: 'cloud-offline-outline' as keyof typeof Ionicons.glyphMap,
        bg: colors.dangerTint,
        fg: colors.danger,
        border: colors.dangerBorder,
      };
    case 'remote':
    default:
      return {
        label: 'Remote',
        icon: 'globe-outline' as keyof typeof Ionicons.glyphMap,
        bg: colors.accentTint,
        fg: colors.accentDark,
        border: colors.accentBorder,
      };
  }
}

export function LanStatusBadge({
  compact = false,
  onPress,
}: {
  compact?: boolean;
  onPress?: () => void;
}) {
  const { lanStatus, refreshLanStatus } = useAuth();
  if (!lanStatus.primaryUrl) return null;

  const meta = badgeMeta(lanStatus.mode, lanStatus.latencyMs, compact);

  return (
    <Pressable
      onPress={onPress ?? (() => void refreshLanStatus(true))}
      hitSlop={6}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: meta.bg, borderColor: meta.border },
        compact && styles.pillCompact,
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`NAS connection mode: ${meta.label}`}
    >
      <View style={[styles.dot, { backgroundColor: meta.fg }]} />
      <Ionicons name={meta.icon} size={compact ? 11 : 12} color={meta.fg} />
      <Text style={[styles.label, { color: meta.fg }, compact && styles.labelCompact]}>
        {meta.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  pillCompact: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    gap: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
  },
  labelCompact: {
    fontSize: 11,
  },
  pressed: {
    opacity: 0.72,
  },
});
