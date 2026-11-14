export const colors = {
  bg: '#f7f9f9',
  surface: '#ffffff',
  surfaceSubtle: '#eef3f3',
  surfacePressed: '#e4ebeb',
  accent: '#14694f',
  accentDark: '#0e573f',
  accentTint: '#e8f3ee',
  accentBorder: '#b7dccb',
  ink: '#182432',
  inkSoft: '#394a5b',
  muted: '#758391',
  line: '#e2e8e8',
  lineStrong: '#cfd8d9',
  success: '#1c8057',
  successTint: '#e6f5ee',
  warning: '#b87314',
  warningTint: '#fef6e7',
  warningBorder: '#f3d9a4',
  danger: '#b75252',
  dangerTint: '#fdeeee',
  dangerBorder: '#efc8c8',
  viewerBg: '#0b1118',
  viewerChrome: 'rgba(11, 17, 24, 0.78)',
  white: '#ffffff',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

export const cardShadow = {
  shadowColor: '#0f1c24',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.05,
  shadowRadius: 8,
  elevation: 2,
} as const;
