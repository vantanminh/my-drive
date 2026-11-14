import type { ExpoConfig, ConfigContext } from 'expo/config';

const DEFAULT_BUNDLE_ID = 'com.mydrive.ios';

export default ({ config }: ConfigContext): ExpoConfig => {
  const bundleIdentifier =
    process.env.IOS_BUNDLE_IDENTIFIER?.trim() || DEFAULT_BUNDLE_ID;
  const buildNumber = process.env.IOS_BUILD_NUMBER?.trim() || '1';
  const version = process.env.IOS_MARKETING_VERSION?.trim() || '1.0.0';
  const appleTeamId = process.env.APPLE_TEAM_ID?.trim() || undefined;

  return {
    ...config,
    name: 'MyDrive',
    slug: 'mydrive-ios',
    scheme: 'mydrive',
    version,
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    ios: {
      supportsTablet: true,
      bundleIdentifier,
      buildNumber,
      ...(appleTeamId ? { appleTeamId } : {}),
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSLocalNetworkUsageDescription:
          'MyDrive connects over your local network to reach a self-hosted NAS server.',
        NSAppTransportSecurity: {
          NSAllowsLocalNetworking: true,
          NSAllowsArbitraryLoads: true,
        },
        UIBackgroundModes: ['fetch', 'processing'],
        BGTaskSchedulerPermittedIdentifiers: [
          'com.mydrive.ios.photo-sync',
          'com.expo.modules.backgroundtask.processing',
        ],
      },
    },
    plugins: [
      [
        'expo-splash-screen',
        {
          image: './assets/splash-icon.png',
          imageWidth: 200,
          resizeMode: 'contain',
          backgroundColor: '#14694f',
        },
      ],
      'expo-secure-store',
      'expo-sqlite',
      'expo-sharing',
      'expo-image',
      'expo-video',
      'expo-background-task',
      [
        'expo-media-library',
        {
          photosPermission:
            'MyDrive accesses your Photo Library to display thumbnails and back up original full-resolution photos and videos—including originals stored in iCloud—to your NAS.',
          savePhotosPermission:
            'MyDrive saves downloaded photos and videos from your NAS into your Photo Library.',
          preventAutomaticLimitedAccessAlert: false,
        },
      ],
    ],
    extra: {
      defaultBundleIdentifier: DEFAULT_BUNDLE_ID,
    },
  };
};
