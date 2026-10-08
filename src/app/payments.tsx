import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { TerritoryShieldPanel } from "@/components/territory-shield-panel";
import { getOrCreatePlayerProfile } from "@/services/player-profile";
import {
  getStoredTerritories,
  subscribeToStoredTerritories,
  updateStoredTerritory,
} from "@/services/territory-storage";
import type { Territory } from "@/types/game";

export default function PaymentsScreen() {
  const insets = useSafeAreaInsets();
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [playerId, setPlayerId] = useState("");

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      void Promise.all([getOrCreatePlayerProfile(), getStoredTerritories()]).then(
        ([profile, storedTerritories]) => {
          if (!mounted) return;
          setPlayerId(profile.id);
          setTerritories(storedTerritories);
        },
      );
      const unsubscribe = subscribeToStoredTerritories((next) => {
        if (mounted) setTerritories(next);
      });
      return () => {
        mounted = false;
        unsubscribe();
      };
    }, []),
  );

  const handleShieldUpdated = useCallback(
    (territoryId: string, shield: Territory["shield"]) => {
      setTerritories((current) => {
        const next = current.map((territory) =>
          territory.id === territoryId ? { ...territory, shield } : territory,
        );
        const updated = next.find((territory) => territory.id === territoryId);
        if (updated) void updateStoredTerritory(updated);
        return next;
      });
    },
    [],
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 110 },
      ]}
    >
      <View style={styles.header}>
        <Text style={styles.title}>PaintFoot.io</Text>
        <Text style={styles.subtitle}>
          Protege temporalmente tus territorios conquistados.
        </Text>
      </View>

      <TerritoryShieldPanel
        territories={territories}
        playerId={playerId}
        onShieldUpdated={handleShieldUpdated}
        displayMode="payments"
      />

      <Text style={styles.securityText}>
        Tus datos de pago se procesan de forma segura y PaintFoot.io no almacena
        la información de tu tarjeta.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101426" },
  content: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    paddingHorizontal: 16,
    gap: 16,
  },
  header: { gap: 4 },
  title: { color: "#FFFFFF", fontSize: 24, fontWeight: "800" },
  subtitle: { color: "#AAB2CF", fontSize: 13 },
  securityText: {
    color: "#7982A2",
    fontSize: 11,
    lineHeight: 17,
    textAlign: "center",
    paddingHorizontal: 12,
  },
});
