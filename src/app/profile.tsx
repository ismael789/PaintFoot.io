import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  getOrCreatePlayerProfile,
  PLAYER_COLORS,
  updatePlayerProfile,
} from "@/services/player-profile";
import {
  appendStoredTerritories,
  getStoredTerritories,
} from "@/services/territory-storage";
import { isTerritoryShieldActive } from "@/services/territory-shields";
import { getLatestTrackingSession } from "@/services/tracking-stats";
import type {
  PlayerProfile,
  Territory,
  TrackingSessionSummary,
} from "@/types/game";

function formatDuration(milliseconds: number) {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours > 0 ? `${hours} h ${remainingMinutes} min` : `${minutes} min`;
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [latestSession, setLatestSession] =
    useState<TrackingSessionSummary | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<(typeof PLAYER_COLORS)[number]>(
    PLAYER_COLORS[0],
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [nextProfile, storedTerritories, session] = await Promise.all([
        getOrCreatePlayerProfile(),
        getStoredTerritories(),
        getLatestTrackingSession(),
      ]);
      setProfile(nextProfile);
      setName(nextProfile.name);
      setColor(nextProfile.color as (typeof PLAYER_COLORS)[number]);
      setTerritories(
        storedTerritories.filter(
          (territory) => territory.playerId === nextProfile.id,
        ),
      );
      setLatestSession(session);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "No se pudo cargar el perfil.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadProfile();
    }, [loadProfile]),
  );

  const statistics = useMemo(() => {
    const now = Date.now();
    return {
      areaM2: territories.reduce(
        (total, territory) => total + territory.areaM2,
        0,
      ),
      protectedTerritories: territories.filter((territory) =>
        isTerritoryShieldActive(territory.shield, now),
      ).length,
    };
  }, [territories]);

  const save = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const updated = await updatePlayerProfile({ name, color });
      const updatedTerritories = territories.map((territory) => ({
        ...territory,
        owner: updated.name,
        color: updated.color,
        playerColor: updated.color,
      }));
      if (updatedTerritories.length > 0) {
        await appendStoredTerritories(updatedTerritories);
        setTerritories(updatedTerritories);
      }
      setProfile(updated);
      setName(updated.name);
      setMessage("Perfil guardado correctamente.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "No se pudo guardar el perfil.",
      );
    } finally {
      setSaving(false);
    }
  }, [color, name, territories]);

  if (loading || !profile) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator color="#40C4FF" size="large" />
        <Text style={styles.loadingText}>Cargando perfil...</Text>
      </View>
    );
  }

  const initial = profile.name.trim().charAt(0).toUpperCase() || "J";

  return (
    <ScrollView
      style={styles.screen}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 110 },
      ]}
    >
      <View style={styles.header}>
        <View style={[styles.avatar, { backgroundColor: color }]}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>{profile.name}</Text>
          <Text style={styles.subtitle}>Perfil de jugador PaintFoot.io</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Datos del jugador</Text>
        <Text style={styles.label}>Nombre visible</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          maxLength={30}
          autoCapitalize="words"
          autoCorrect={false}
          placeholder="Nombre del jugador"
          placeholderTextColor="#6F7897"
          selectionColor="#40C4FF"
          style={styles.input}
        />

        <Text style={styles.label}>Color en el mapa</Text>
        <View style={styles.colorRow}>
          {PLAYER_COLORS.map((playerColor) => (
            <Pressable
              key={playerColor}
              accessibilityLabel={`Seleccionar color ${playerColor}`}
              onPress={() => setColor(playerColor)}
              style={[
                styles.colorButton,
                { backgroundColor: playerColor },
                color === playerColor && styles.colorButtonSelected,
              ]}
            >
              {color === playerColor && <Text style={styles.check}>✓</Text>}
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>Identificador permanente</Text>
        <Text selectable style={styles.playerId}>{profile.id}</Text>
        <Text style={styles.identifierHelp}>
          Este identificador conserva la propiedad de tus territorios y no cambia al editar el perfil.
        </Text>

        <Pressable
          disabled={saving}
          onPress={() => void save()}
          style={({ pressed }) => [
            styles.saveButton,
            pressed && styles.pressed,
            saving && styles.disabled,
          ]}
        >
          {saving ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.saveButtonText}>Guardar perfil</Text>
          )}
        </Pressable>
        {message && <Text style={styles.message}>{message}</Text>}
      </View>

      <View style={styles.statsGrid}>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{territories.length}</Text>
          <Text style={styles.statLabel}>Territorios</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>
            {Math.round(statistics.areaM2).toLocaleString()}
          </Text>
          <Text style={styles.statLabel}>Área total m²</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{statistics.protectedTerritories}</Text>
          <Text style={styles.statLabel}>Protegidos</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Último recorrido</Text>
        {latestSession ? (
          <View style={styles.sessionDetails}>
            <Text style={styles.sessionText}>
              Distancia: {Math.round(latestSession.distanceMeters).toLocaleString()} m
            </Text>
            <Text style={styles.sessionText}>
              Duración: {formatDuration(latestSession.durationMs)}
            </Text>
            <Text style={styles.sessionText}>
              Pasos: {latestSession.steps?.toLocaleString() ?? "No disponibles"}
            </Text>
            <Text style={styles.sessionText}>
              Territorios conquistados: {latestSession.territoriesCaptured}
            </Text>
            <Text style={styles.sessionText}>
              Área conquistada: {Math.round(latestSession.areaCapturedM2).toLocaleString()} m²
            </Text>
          </View>
        ) : (
          <Text style={styles.emptyText}>
            Completa tu primer recorrido para ver estadísticas aquí.
          </Text>
        )}
      </View>

      <Text style={styles.localNotice}>
        El perfil se guarda en este dispositivo. No contiene información de pago ni datos de tarjeta.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101426" },
  content: { paddingHorizontal: 16, gap: 18 },
  loadingScreen: { flex: 1, backgroundColor: "#101426", alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { color: "#C5CAE9", fontSize: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 14 },
  avatar: { width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: "#FFFFFF" },
  avatarText: { color: "#FFFFFF", fontSize: 30, fontWeight: "900" },
  headerText: { flex: 1 },
  title: { color: "#FFFFFF", fontSize: 25, fontWeight: "900" },
  subtitle: { color: "#AAB2CF", fontSize: 13, marginTop: 4 },
  card: { backgroundColor: "#1A1A2E", borderRadius: 18, padding: 16, gap: 10 },
  cardTitle: { color: "#FFFFFF", fontSize: 18, fontWeight: "900", marginBottom: 2 },
  label: { color: "#C5CAE9", fontSize: 12, fontWeight: "800", marginTop: 4 },
  input: { color: "#FFFFFF", backgroundColor: "#252C4D", borderRadius: 12, borderWidth: 1, borderColor: "#39436B", fontSize: 16, paddingHorizontal: 13, paddingVertical: 12 },
  colorRow: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingVertical: 3 },
  colorButton: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  colorButtonSelected: { borderWidth: 3, borderColor: "#FFFFFF" },
  check: { color: "#FFFFFF", fontSize: 20, fontWeight: "900" },
  playerId: { color: "#80CBC4", backgroundColor: "#11182C", borderRadius: 9, padding: 10, fontFamily: "monospace", fontSize: 12 },
  identifierHelp: { color: "#858FAC", fontSize: 11, lineHeight: 16 },
  saveButton: { minHeight: 48, backgroundColor: "#3949AB", borderRadius: 13, alignItems: "center", justifyContent: "center", marginTop: 4 },
  saveButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.55 },
  message: { color: "#FFE082", fontSize: 12, lineHeight: 17, textAlign: "center" },
  statsGrid: { flexDirection: "row", gap: 10 },
  statCard: { flex: 1, minHeight: 96, backgroundColor: "#1A1A2E", borderRadius: 16, alignItems: "center", justifyContent: "center", padding: 10 },
  statValue: { color: "#72E6BE", fontSize: 20, fontWeight: "900" },
  statLabel: { color: "#AAB2CF", fontSize: 11, textAlign: "center", marginTop: 5 },
  sessionDetails: { gap: 8 },
  sessionText: { color: "#D6DAEA", fontSize: 13 },
  emptyText: { color: "#929BB8", fontSize: 13, lineHeight: 19 },
  localNotice: { color: "#707A99", fontSize: 11, lineHeight: 17, textAlign: "center", paddingHorizontal: 18 },
});
