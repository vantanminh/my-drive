import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { cardShadow, colors, radius, spacing } from '../theme/tokens';

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export type ButtonVariant = 'primary' | 'secondary' | 'subtle' | 'danger' | 'ghost';

export function AppButton({
  title,
  onPress,
  variant = 'primary',
  icon,
  loading = false,
  disabled = false,
  compact = false,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  compact?: boolean;
  style?: ViewStyle;
}) {
  const isDisabled = disabled || loading;
  const textColor =
    variant === 'primary' || variant === 'danger'
      ? colors.white
      : variant === 'secondary' || variant === 'subtle'
        ? colors.accent
        : colors.ink;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.buttonBase,
        compact && styles.buttonCompact,
        styles[`button_${variant}`],
        pressed && !isDisabled && styles[`buttonPressed_${variant}`],
        isDisabled && styles.buttonDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={textColor} />
      ) : (
        <>
          {icon ? (
            <Ionicons
              name={icon}
              size={compact ? 16 : 18}
              color={textColor}
              style={styles.buttonIcon}
            />
          ) : null}
          <Text
            style={[
              styles.buttonText,
              compact && styles.buttonTextCompact,
              { color: textColor },
            ]}
            numberOfLines={1}
          >
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

export type BadgeTone = 'accent' | 'neutral' | 'success' | 'warning' | 'danger';

export function StatusBadge({
  label,
  tone = 'neutral',
  icon,
}: {
  label: string;
  tone?: BadgeTone;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const palette = BADGE_PALETTES[tone];
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: palette.bg, borderColor: palette.border },
      ]}
    >
      {icon ? (
        <Ionicons
          name={icon}
          size={12}
          color={palette.fg}
          style={styles.badgeIcon}
        />
      ) : null}
      <Text style={[styles.badgeText, { color: palette.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const BADGE_PALETTES: Record<
  BadgeTone,
  { bg: string; fg: string; border: string }
> = {
  accent: {
    bg: colors.accentTint,
    fg: colors.accentDark,
    border: colors.accentBorder,
  },
  neutral: {
    bg: colors.surfaceSubtle,
    fg: colors.inkSoft,
    border: colors.line,
  },
  success: {
    bg: colors.successTint,
    fg: colors.success,
    border: colors.accentBorder,
  },
  warning: {
    bg: colors.warningTint,
    fg: colors.warning,
    border: colors.warningBorder,
  },
  danger: {
    bg: colors.dangerTint,
    fg: colors.danger,
    border: colors.dangerBorder,
  },
};

export function TextField({
  label,
  helper,
  error,
  rightAccessory,
  style,
  ...rest
}: TextInputProps & {
  label?: string;
  helper?: string;
  error?: string | null;
  rightAccessory?: React.ReactNode;
}) {
  return (
    <View style={styles.fieldWrap}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <View
        style={[
          styles.inputBox,
          error ? styles.inputBoxError : undefined,
        ]}
      >
        <TextInput
          placeholderTextColor={colors.muted}
          style={[styles.inputText, style]}
          {...rest}
        />
        {rightAccessory}
      </View>
      {error ? (
        <Text style={styles.fieldError}>{error}</Text>
      ) : helper ? (
        <Text style={styles.fieldHelper}>{helper}</Text>
      ) : null}
    </View>
  );
}

export function Banner({
  tone = 'neutral',
  icon,
  title,
  message,
  actionLabel,
  onAction,
}: {
  tone?: BadgeTone;
  icon: keyof typeof Ionicons.glyphMap;
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const palette = BADGE_PALETTES[tone];
  return (
    <View
      style={[
        styles.banner,
        { backgroundColor: palette.bg, borderColor: palette.border },
      ]}
    >
      <Ionicons name={icon} size={20} color={palette.fg} style={styles.bannerIcon} />
      <View style={styles.bannerContent}>
        {title ? (
          <Text style={[styles.bannerTitle, { color: palette.fg }]}>{title}</Text>
        ) : null}
        <Text style={[styles.bannerText, { color: colors.inkSoft }]}>{message}</Text>
        {actionLabel && onAction ? (
          <Pressable onPress={onAction} style={styles.bannerAction}>
            <Text style={[styles.bannerActionText, { color: palette.fg }]}>
              {actionLabel}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  actionTitle,
  onAction,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  message: string;
  actionTitle?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIconCircle}>
        <Ionicons name={icon} size={30} color={colors.accent} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyMessage}>{message}</Text>
      {actionTitle && onAction ? (
        <AppButton
          title={actionTitle}
          onPress={onAction}
          variant="secondary"
          compact
          style={styles.emptyButton}
        />
      ) : null}
    </View>
  );
}

export function SectionTitle({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionHeaderText}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export function KeyValueRow({
  label,
  value,
  last = false,
}: {
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <View style={[styles.kvRow, !last && styles.kvRowBorder]}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={styles.kvValue} numberOfLines={2} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.lg,
    ...cardShadow,
  },
  buttonBase: {
    minHeight: 48,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonCompact: {
    minHeight: 38,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
  },
  buttonIcon: {
    marginRight: spacing.sm,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  buttonTextCompact: {
    fontSize: 13.5,
  },
  button_primary: {
    backgroundColor: colors.accent,
  },
  buttonPressed_primary: {
    backgroundColor: colors.accentDark,
  },
  button_secondary: {
    backgroundColor: colors.accentTint,
    borderWidth: 1,
    borderColor: colors.accentBorder,
  },
  buttonPressed_secondary: {
    backgroundColor: '#d7ebe2',
  },
  button_subtle: {
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.line,
  },
  buttonPressed_subtle: {
    backgroundColor: colors.surfacePressed,
  },
  button_danger: {
    backgroundColor: colors.danger,
  },
  buttonPressed_danger: {
    backgroundColor: '#9c4040',
  },
  button_ghost: {
    backgroundColor: 'transparent',
  },
  buttonPressed_ghost: {
    backgroundColor: colors.surfaceSubtle,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  badgeIcon: {
    marginRight: 4,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  fieldWrap: {
    marginBottom: spacing.md,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.inkSoft,
    marginBottom: spacing.xs + 2,
  },
  inputBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: 48,
  },
  inputBoxError: {
    borderColor: colors.danger,
  },
  inputText: {
    flex: 1,
    fontSize: 15,
    color: colors.ink,
    paddingVertical: spacing.sm + 2,
  },
  fieldHelper: {
    fontSize: 12,
    color: colors.muted,
    marginTop: spacing.xs + 2,
    lineHeight: 16,
  },
  fieldError: {
    fontSize: 12.5,
    color: colors.danger,
    marginTop: spacing.xs + 2,
    fontWeight: '500',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  bannerIcon: {
    marginRight: spacing.sm + 2,
    marginTop: 1,
  },
  bannerContent: {
    flex: 1,
  },
  bannerTitle: {
    fontSize: 13.5,
    fontWeight: '700',
    marginBottom: 2,
  },
  bannerText: {
    fontSize: 13,
    lineHeight: 18,
  },
  bannerAction: {
    marginTop: spacing.xs + 2,
    alignSelf: 'flex-start',
  },
  bannerActionText: {
    fontSize: 13,
    fontWeight: '700',
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxxl,
    paddingVertical: spacing.xxxl + 16,
  },
  emptyIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
    marginBottom: spacing.xs + 2,
  },
  emptyMessage: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyButton: {
    marginTop: spacing.lg,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm + 2,
  },
  sectionHeaderText: {
    flex: 1,
    paddingRight: spacing.sm,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    color: colors.muted,
  },
  sectionSubtitle: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 2,
  },
  kvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm + 2,
    gap: spacing.md,
  },
  kvRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  kvLabel: {
    fontSize: 13.5,
    color: colors.muted,
    fontWeight: '500',
  },
  kvValue: {
    flex: 1,
    textAlign: 'right',
    fontSize: 13.5,
    color: colors.ink,
    fontWeight: '600',
  },
});
