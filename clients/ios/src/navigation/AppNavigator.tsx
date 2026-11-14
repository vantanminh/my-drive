import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { AlbumDetailScreen } from '../screens/AlbumDetailScreen';
import { ChangePasswordModal } from '../screens/ChangePasswordModal';
import { FileViewerScreen } from '../screens/FileViewerScreen';
import { FilesScreen } from '../screens/FilesScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { PhotoViewerScreen } from '../screens/PhotoViewerScreen';
import { PhotosScreen } from '../screens/PhotosScreen';
import { ServerSetupScreen } from '../screens/ServerSetupScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { SyncScreen } from '../screens/SyncScreen';
import type { MainTabParamList, RootStackParamList } from './types';
import { colors, spacing } from '../theme/tokens';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<MainTabParamList>();

const APP_THEME = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: colors.bg,
    card: colors.surface,
    text: colors.ink,
    border: colors.line,
    primary: colors.accent,
  },
};

function MainTabs() {
  const { snapshot } = useSync();

  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.line,
        },
        tabBarIcon: ({ color, size, focused }) => {
          let name: keyof typeof Ionicons.glyphMap = 'images-outline';
          if (route.name === 'Photos') {
            name = focused ? 'images' : 'images-outline';
          } else if (route.name === 'Files') {
            name = focused ? 'folder' : 'folder-outline';
          } else if (route.name === 'Sync') {
            name = focused ? 'cloud-upload' : 'cloud-upload-outline';
          } else if (route.name === 'Settings') {
            name = focused ? 'settings' : 'settings-outline';
          }
          return <Ionicons name={name} size={size} color={color} />;
        },
      })}
    >
      <Tabs.Screen name="Photos" component={PhotosScreen} />
      <Tabs.Screen name="Files" component={FilesScreen} />
      <Tabs.Screen
        name="Sync"
        component={SyncScreen}
        options={{
          tabBarBadge: snapshot.running ? '•' : undefined,
        }}
      />
      <Tabs.Screen name="Settings" component={SettingsScreen} />
    </Tabs.Navigator>
  );
}

export function AppNavigator() {
  const { bootstrapping, serverUrl, user } = useAuth();

  if (bootstrapping) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.splashText}>Connecting to MyDrive…</Text>
      </View>
    );
  }

  if (!serverUrl) {
    return <ServerSetupScreen />;
  }

  if (!user) {
    return <LoginScreen />;
  }

  return (
    <NavigationContainer theme={APP_THEME}>
      <Stack.Navigator
        screenOptions={{
          headerTintColor: colors.accent,
          headerStyle: { backgroundColor: colors.surface },
          headerTitleStyle: { color: colors.ink, fontWeight: '700' },
        }}
      >
        {user.must_change_password ? (
          <Stack.Screen
            name="ChangePassword"
            component={ChangePasswordModal}
            initialParams={{ required: true }}
            options={{ headerShown: false, gestureEnabled: false }}
          />
        ) : (
          <>
            <Stack.Screen
              name="MainTabs"
              component={MainTabs}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="PhotoViewer"
              component={PhotoViewerScreen}
              options={{
                headerShown: false,
                presentation: 'fullScreenModal',
                animation: 'fade',
              }}
            />
            <Stack.Screen
              name="FileViewer"
              component={FileViewerScreen}
              options={{ title: 'Preview', headerBackTitle: 'Files' }}
            />
            <Stack.Screen
              name="AlbumDetail"
              component={AlbumDetailScreen}
              options={{ title: 'Album', headerBackTitle: 'Photos' }}
            />
            <Stack.Screen
              name="ChangePassword"
              component={ChangePasswordModal}
              options={{
                presentation: 'modal',
                headerShown: false,
              }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  splashText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.inkSoft,
  },
});
