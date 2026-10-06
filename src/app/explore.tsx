import Constants from "expo-constants";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  SENSOR_CATEGORIES,
  sensorCapabilityManager,
  type SensorCapabilityState,
  type SensorOperationalStatus,
} from "@/services/sensor-capabilities";

const STATUS_PRESENTATION: Record<
  SensorOperationalStatus,
  { icon: string; label: string; color: string }
> = {
  checking: { icon: "⚪", label: "Comprobando", color: "#8A94A6" },
  available: { icon: "⚪", label: "Disponible / Inactivo", color: "#8A94A6" },
  active: { icon: "🟢", label: "Activo", color: "#2E9B52" },
  unavailable: { icon: "❌", label: "No disponible en este dispositivo", color: "#C94141" },
  "temporarily-unavailable": { icon: "⚠️", label: "No disponible temporalmente", color: "#E58B18" },
  "apk-only": { icon: "📱", label: "Solo APK Android", color: "#536DFE" },
  "low-accuracy": { icon: "⚠️", label: "Precision baja", color: "#E58B18" },
  interference: { icon: "⚠️", label: "Interferencia", color: "#E58B18" },
};

function SensorRow({ sensor }: { sensor: SensorCapabilityState }) {
  const presentation = STATUS_PRESENTATION[sensor.status];
  return (
    <View style={styles.sensorRow}>
      <Text style={styles.sensorIcon}>{presentation.icon}</Text>
      <View style={styles.sensorContent}>
        <View style={styles.sensorTitleRow}>
          <Text style={styles.sensorName}>{sensor.name}</Text>
          {sensor.value && <Text style={styles.sensorValue}>{sensor.value}</Text>}
        </View>
        <Text style={[styles.sensorStatus, { color: presentation.color }]}>
          {presentation.label}
        </Text>
        <Text style={styles.sensorPurpose}>{sensor.purpose}</Text>
        {sensor.details?.name && (
          <Text style={styles.sensorDetails}>
            {sensor.details.name} · {sensor.details.vendor}
          </Text>
        )}
      </View>
    </View>
  );
}

export default function DeviceSensorsScreen() {
  const insets = useSafeAreaInsets();
  const sensors = useSyncExternalStore(
    sensorCapabilityManager.subscribe,
    sensorCapabilityManager.getSnapshot,
    sensorCapabilityManager.getSnapshot,
  );
  const [refreshing, setRefreshing] = useState(false);
  const isExpoGo = Constants.expoGoConfig !== null;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await sensorCapabilityManager.refresh();
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const availableCount = sensors.filter(
    (sensor) => sensor.available === true,
  ).length;
  const activeCount = sensors.filter((sensor) => sensor.active).length;
  const unavailableCount = sensors.filter(
    (sensor) => sensor.available === false,
  ).length;
  const apkOnlyCount = sensors.filter(
    (sensor) => sensor.status === "apk-only",
  ).length;
  const interferenceCount = sensors.filter(
    (sensor) => sensor.status === "interference",
  ).length;
  const gpsAvailable = sensors.find((sensor) => sensor.id === "gps")?.available;
  const confidence = sensorCapabilityManager.getConfidence();

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 110 },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Sensores del dispositivo</Text>
          <Text style={styles.subtitle}>
            Deteccion real del hardware y estado del seguimiento
          </Text>
        </View>
        <Pressable style={styles.refreshButton} onPress={refresh} disabled={refreshing}>
          {refreshing ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Text style={styles.refreshText}>Actualizar</Text>
          )}
        </Pressable>
      </View>

      <View style={styles.summaryCard}>
        <Text style={styles.summaryTitle}>
          Sensores disponibles: {availableCount} / {sensors.length}
        </Text>
        <Text style={styles.summaryLine}>Sensores activos: {activeCount}</Text>
        <Text style={styles.summaryLine}>
          Interferencias: {interferenceCount === 0 ? "Ninguna" : interferenceCount}
        </Text>
        <Text style={styles.summaryLine}>
          Tracking: {confidence === "high" ? "Alta" : confidence === "medium" ? "Media" : "Baja"} confianza
        </Text>
        <Text style={[styles.gameStatus, !gpsAvailable && styles.gameStatusWarning]}>
          {gpsAvailable
            ? unavailableCount > 0 || apkOnlyCount > 0
              ? "✅ PaintFoot.io puede funcionar normalmente con los sensores compatibles."
              : "✅ Juego completamente funcional."
            : "⚠️ Se necesita GPS para iniciar un recorrido y conquistar territorio."}
        </Text>
        {(unavailableCount > 0 || apkOnlyCount > 0) && gpsAvailable && (
          <Text style={styles.fallbackText}>
            {unavailableCount + apkOnlyCount} sensores opcionales no estan disponibles en este entorno. Los sensores restantes se utilizan automaticamente.
          </Text>
        )}
        {isExpoGo && apkOnlyCount > 0 && (
          <Text style={styles.apkNotice}>
            Los sensores Android nativos se detectan en Development Build o APK. Expo Go no permite cargar el modulo Kotlin personalizado.
          </Text>
        )}
      </View>

      {SENSOR_CATEGORIES.map((category) => (
        <View key={category} style={styles.category}>
          <Text style={styles.categoryTitle}>{category.toUpperCase()}</Text>
          <View style={styles.card}>
            {sensors
              .filter((sensor) => sensor.category === category)
              .map((sensor) => (
                <SensorRow key={sensor.id} sensor={sensor} />
              ))}
          </View>
        </View>
      ))}

      <View style={styles.explanationCard}>
        <Text style={styles.explanationTitle}>Dependencias del juego</Text>
        <Text style={styles.explanationText}>
          Conquistar requiere GPS, Map Matching, segmentos viales, perimetro completo y un poligono valido. Los demas sensores mejoran movimiento, orientacion, estadisticas y experiencia visual, pero ninguno crea territorio por si solo.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101426" },
  content: { paddingHorizontal: 16, gap: 18 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  headerText: { flex: 1 },
  title: { color: "#FFFFFF", fontSize: 24, fontWeight: "800" },
  subtitle: { color: "#AAB2CF", fontSize: 13, marginTop: 4 },
  refreshButton: { backgroundColor: "#3949AB", borderRadius: 10, minWidth: 92, paddingHorizontal: 12, paddingVertical: 10, alignItems: "center" },
  refreshText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
  summaryCard: { backgroundColor: "#1A1A2E", borderRadius: 18, padding: 16, gap: 6 },
  summaryTitle: { color: "#FFFFFF", fontSize: 18, fontWeight: "800" },
  summaryLine: { color: "#C5CAE9", fontSize: 13 },
  gameStatus: { color: "#7EE29A", fontSize: 13, fontWeight: "700", marginTop: 6, lineHeight: 19 },
  gameStatusWarning: { color: "#FFBF69" },
  fallbackText: { color: "#C5CAE9", fontSize: 12, lineHeight: 18 },
  apkNotice: { color: "#9FA8FF", fontSize: 12, lineHeight: 18, marginTop: 4 },
  category: { gap: 8 },
  categoryTitle: { color: "#9FA8DA", fontSize: 12, fontWeight: "800", letterSpacing: 1.1 },
  card: { backgroundColor: "#1A1A2E", borderRadius: 16, overflow: "hidden" },
  sensorRow: { flexDirection: "row", padding: 14, gap: 10, borderBottomColor: "#292B46", borderBottomWidth: StyleSheet.hairlineWidth },
  sensorIcon: { fontSize: 16, width: 24 },
  sensorContent: { flex: 1, gap: 2 },
  sensorTitleRow: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  sensorName: { color: "#FFFFFF", fontSize: 14, fontWeight: "700", flex: 1 },
  sensorValue: { color: "#80CBC4", fontSize: 12, fontWeight: "700" },
  sensorStatus: { fontSize: 12, fontWeight: "700" },
  sensorPurpose: { color: "#AAB2CF", fontSize: 11, lineHeight: 16 },
  sensorDetails: { color: "#7982A2", fontSize: 10 },
  explanationCard: { backgroundColor: "#162F33", borderRadius: 16, padding: 15, gap: 5 },
  explanationTitle: { color: "#80CBC4", fontSize: 14, fontWeight: "800" },
  explanationText: { color: "#D5E8E6", fontSize: 12, lineHeight: 18 },
});
