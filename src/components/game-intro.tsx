import { Palette } from "@/constants/palette";
import * as SplashScreen from "expo-splash-screen";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewProps } from "react-native-webview";

const INTRO_ANIMATION_SOURCE = require("../../paintfoot-tenis-responsive.html") as NonNullable<
  WebViewProps["source"]
>;
const EXIT_DURATION_MS = 450;

type GameIntroProps = {
  onComplete: () => void;
};

export function GameIntro({ onComplete }: GameIntroProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [isReady, setIsReady] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const introOpacity = useRef(new Animated.Value(1)).current;
  const promptOpacity = useRef(new Animated.Value(0)).current;
  const promptAnimationRef = useRef<Animated.CompositeAnimation | null>(null);

  const revealIntro = useCallback(() => {
    if (isReady) return;
    setIsReady(true);
    void SplashScreen.hideAsync();
  }, [isReady]);

  useEffect(() => {
    if (!isReady) return;

    const promptAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(promptOpacity, {
          toValue: 1,
          duration: 700,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(promptOpacity, {
          toValue: 0.38,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );

    promptAnimationRef.current = promptAnimation;
    promptAnimation.start();

    return () => promptAnimation.stop();
  }, [isReady, promptOpacity]);

  const startGame = useCallback(() => {
    if (!isReady || isExiting) return;

    setIsExiting(true);
    promptAnimationRef.current?.stop();
    Animated.timing(introOpacity, {
      toValue: 0,
      duration: EXIT_DURATION_MS,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) onComplete();
    });
  }, [introOpacity, isExiting, isReady, onComplete]);

  return (
    <Animated.View style={[styles.container, { opacity: introOpacity }]}>
      <WebView
        pointerEvents="none"
        style={styles.animation}
        originWhitelist={["*"]}
        source={INTRO_ANIMATION_SOURCE}
        javaScriptEnabled
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        setSupportMultipleWindows={false}
        onLoadEnd={revealIntro}
        onError={revealIntro}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Toca para comenzar"
        disabled={!isReady || isExiting}
        onPress={startGame}
        style={styles.touchSurface}
      >
        <View
          style={[styles.promptArea, { paddingBottom: Math.max(24, insets.bottom + 24) }]}
          pointerEvents="none"
        >
          <Animated.View
            style={[
              styles.promptPill,
              { maxWidth: Math.max(220, width - 32), opacity: promptOpacity },
            ]}
          >
            <Text style={styles.promptText}>Toca para comenzar</Text>
          </Animated.View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Palette.white,
  },
  animation: {
    flex: 1,
    backgroundColor: Palette.white,
  },
  touchSurface: {
    ...StyleSheet.absoluteFill,
  },
  promptArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: 24,
    paddingBottom: 54,
  },
  promptPill: {
    borderRadius: 999,
    backgroundColor: Palette.overlayNavyStrong,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  promptText: {
    color: Palette.white,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.5,
    textAlign: "center",
  },
});
