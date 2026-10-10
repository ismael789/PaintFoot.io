import { Palette } from "@/constants/palette";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Animated,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  getFeedbackSnapshot,
  subscribeToFeedback,
  type FeedbackMessage,
  type FeedbackType,
} from "@/services/global-feedback";

const VISUALS: Record<FeedbackType, { icon: string; label: string; color: string }> = {
  info: { icon: "i", label: "Información", color: Palette.sky400 },
  success: { icon: "✓", label: "Completado", color: Palette.success },
  warning: { icon: "!", label: "Atención", color: Palette.gold },
  error: { icon: "×", label: "No completado", color: Palette.dangerSoft },
};

export function GlobalFeedback() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const snapshot = useSyncExternalStore(
    subscribeToFeedback,
    getFeedbackSnapshot,
    getFeedbackSnapshot,
  );
  const [displayed, setDisplayed] = useState<FeedbackMessage | null>(
    snapshot.current,
  );
  const opacity = useRef(new Animated.Value(snapshot.current ? 1 : 0)).current;
  const translateY = useRef(new Animated.Value(snapshot.current ? 0 : -12)).current;

  useEffect(() => {
    if (snapshot.current) {
      setDisplayed(snapshot.current);
      opacity.setValue(0);
      translateY.setValue(-12);
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: -8,
        duration: 150,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) setDisplayed(null);
    });
  }, [opacity, snapshot.current, translateY]);

  if (!displayed) return null;
  const visual = VISUALS[displayed.type];
  const dark = colorScheme !== "light";

  return (
    <View
      pointerEvents="none"
      style={[styles.layer, { top: insets.top + 8 }]}
    >
      <Animated.View
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        accessibilityLabel={`${visual.label}: ${displayed.message}`}
        style={[
          styles.card,
          {
            backgroundColor: dark ? Palette.overlayNavy : Palette.overlayLight,
            borderColor: visual.color,
            opacity,
            transform: [{ translateY }],
          },
        ]}
      >
        <View style={[styles.icon, { backgroundColor: visual.color }]}>
          <Text style={styles.iconText}>{visual.icon}</Text>
        </View>
        <View style={styles.copy}>
          <Text style={[styles.label, { color: visual.color }]}>{visual.label}</Text>
          <Text style={[styles.message, { color: dark ? Palette.white : Palette.navy800 }]}>
            {displayed.message}
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 1000,
    elevation: 24,
    alignItems: "center",
  },
  card: {
    width: "100%",
    maxWidth: 520,
    minHeight: 58,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 13,
    paddingVertical: 10,
    shadowColor: Palette.black,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.28,
    shadowRadius: 10,
  },
  icon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  iconText: { color: Palette.navy900, fontSize: 18, fontWeight: "900" },
  copy: { flex: 1 },
  label: { fontSize: 10, fontWeight: "900", letterSpacing: 0.7, textTransform: "uppercase" },
  message: { fontSize: 14, fontWeight: "700", lineHeight: 19, marginTop: 1 },
});
