import { DarkTheme, DefaultTheme, router, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';

import AppTabs from '@/components/app-tabs';
import { GameIntro } from '@/components/game-intro';
import { subscribeToNotificationResponses } from '@/services/push-notifications';

SplashScreen.preventAutoHideAsync();

function AppContent() {
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

  return <AppTabs />;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [hasStarted, setHasStarted] = useState(false);
  const enterGame = useCallback(() => setHasStarted(true), []);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {hasStarted ? <AppContent /> : <GameIntro onComplete={enterGame} />}
    </ThemeProvider>
  );
}
