import { DarkTheme, DefaultTheme, router, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useState } from 'react';
import { useColorScheme, View } from 'react-native';

import AppTabs from '@/components/app-tabs';
import { AuthGate } from '@/components/auth-gate';
import { GameIntro } from '@/components/game-intro';
import { GlobalFeedback } from '@/components/global-feedback';
import { subscribeToNotificationResponses } from '@/services/push-notifications';
import { startOfflineSynchronization } from '@/services/offline-sync';
import { saveTrustedServerTime } from '@/services/offline-storage';
import {
  checkSupabaseConnection,
  startSupabaseSessionLifecycle,
} from '@/services/supabase';

SplashScreen.preventAutoHideAsync();

function AppContent() {
  useEffect(() => {
    const stopSessionLifecycle = startSupabaseSessionLifecycle();
    const stopOfflineSynchronization = startOfflineSynchronization();

    void checkSupabaseConnection().then((status) => {
      if (status.connected) {
        console.info('[Supabase] Conexion lista.');
        if (status.serverTimeMs) {
          void saveTrustedServerTime(status.serverTimeMs);
        }
      }
      else if (status.configured) {
        console.info(
          '[Supabase] Sin conexion por ahora; la app continuara en modo local.',
        );
      } else {
        console.warn('[Supabase] Faltan las variables publicas de configuracion.');
      }
    });

    return () => {
      stopOfflineSynchronization();
      stopSessionLifecycle();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: () => void = () => undefined;

    void subscribeToNotificationResponses((url) => router.push(url)).then(
      (removeListener) => {
        if (cancelled) removeListener();
        else unsubscribe = removeListener;
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <View style={{ flex: 1 }}>
      <AppTabs />
      <GlobalFeedback />
    </View>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [hasStarted, setHasStarted] = useState(false);
  const enterGame = useCallback(() => setHasStarted(true), []);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {hasStarted ? (
        <AuthGate>
          <AppContent />
        </AuthGate>
      ) : (
        <GameIntro onComplete={enterGame} />
      )}
    </ThemeProvider>
  );
}
