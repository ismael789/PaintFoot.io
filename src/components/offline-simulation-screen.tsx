import { useCallback, useEffect, useMemo, useState } from "react";
import * as Location from "expo-location";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import {
  emptySimulationState,
  buildSimulationRoute,
  SIMULATION_ROUTE,
  simulationPipeline,
  territoryStatusLabel,
  type OfflineSimulationState,
} from "@/services/offline-simulation-logic";
import {
  addOfflineSimulationPoint,
  closeOfflineSimulationPerimeter,
  loadOfflineSimulation,
  resetOfflineSimulation,
  restoreOfflineSimulationInternet,
  setOfflineSimulationCache,
  startOfflineSimulation,
} from "@/services/offline-simulation";

interface OfflineSimulationScreenProps {
  visible: boolean;
  onClose: () => void;
  playerColor: string;
}

function timeLabel(timestamp: number | null) {
  if (!timestamp) return "--:--:--";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function buildMapHtml(state: OfflineSimulationState, playerColor: string) {
  const all = buildSimulationRoute(
    state.centerLatitude !== null && state.centerLongitude !== null
      ? {
          latitude: state.centerLatitude,
          longitude: state.centerLongitude,
          accuracy: state.centerAccuracy,
        }
      : null,
  );
  const minLat = Math.min(...all.map((point) => point.latitude));
  const maxLat = Math.max(...all.map((point) => point.latitude));
  const minLng = Math.min(...all.map((point) => point.longitude));
  const maxLng = Math.max(...all.map((point) => point.longitude));
  const toXY = (latitude: number, longitude: number) => ({
    x: 24 + ((longitude - minLng) / (maxLng - minLng)) * 272,
    y: 196 - ((latitude - minLat) / (maxLat - minLat)) * 160,
  });
  const visiblePoints = state.points.map((point) =>
    toXY(point.latitude, point.longitude),
  );
  const coordinates = visiblePoints.map((point) => `${point.x},${point.y}`).join(" ");
  const shouldFill =
    state.territoryStatus === "validated_offline" ||
    state.territoryStatus === "confirmed_simulation";
  const safePlayerColor = /^#[0-9a-f]{6}$/i.test(playerColor)
    ? playerColor
    : "#40C4FF";
  const dots = visiblePoints
    .map(
      (point, index) =>
        `<circle cx="${point.x}" cy="${point.y}" r="5" fill="${
          index === visiblePoints.length - 1 ? "#72E6BE" : "#40C4FF"
        }" stroke="#fff" stroke-width="2"/>`,
    )
    .join("");
  const status = territoryStatusLabel(state.territoryStatus);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
    <style>html,body{margin:0;background:#11182c;overflow:hidden;font-family:Arial;color:#fff}
    svg{display:block;width:100%;height:220px}.grid{stroke:#263354;stroke-width:1}.road{stroke:#344362;stroke-width:8;fill:none;stroke-linecap:round}
    .territory{fill:${safePlayerColor};fill-opacity:.62;stroke:none}
    .route{stroke:${shouldFill ? safePlayerColor : "#40c4ff"};stroke-width:5;fill:none;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 3px ${safePlayerColor})}
    .label{position:absolute;left:12px;bottom:10px;background:rgba(9,14,29,.86);padding:6px 9px;border-radius:8px;font-size:11px;color:${shouldFill ? "#72e6be" : "#ffe082"}}</style></head>
    <body><svg viewBox="0 0 320 220" aria-label="Ruta simulada">
      <path class="grid" d="M0 55H320M0 110H320M0 165H320M80 0V220M160 0V220M240 0V220"/>
      <polyline class="road" points="24,196 296,196 296,36 24,36 24,196"/>
      ${shouldFill && visiblePoints.length >= 3 ? `<polygon class="territory" points="${coordinates}"/>` : ""}
      ${coordinates ? `<polyline class="route" points="${coordinates}"/>` : ""}${dots}
    </svg><div class="label">${status}</div></body></html>`;
}

function StatusPill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "good" | "warning" | "active" | "neutral";
}) {
  return (
    <View style={[styles.pill, styles[`pill_${tone}`]]}>
      <Text style={[styles.pillText, styles[`pillText_${tone}`]]}>{label}</Text>
    </View>
  );
}

export function OfflineSimulationScreen({
  visible,
  onClose,
  playerColor,
}: OfflineSimulationScreenProps) {
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const compactLayout = width < 380 || fontScale > 1.15;
  const [state, setState] = useState(emptySimulationState);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showSavedData, setShowSavedData] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setState(await loadOfflineSimulation());
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo abrir la simulacion.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (visible) void refresh();
  }, [refresh, visible]);

  const run = useCallback(
    async (action: () => Promise<OfflineSimulationState>) => {
      setBusy(true);
      setMessage(null);
      try {
        setState(await action());
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "La accion no pudo completarse.");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const latestPoint = state.points.at(-1);
  const pipeline = useMemo(() => simulationPipeline(state), [state]);
  const mapHtml = useMemo(() => buildMapHtml(state, playerColor), [playerColor, state]);
  const hasSession = Boolean(state.sessionId);

  const startNearCurrentLocation = useCallback(() => {
    void run(async () => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== Location.PermissionStatus.GRANTED) {
        throw new Error(
          "Permite la ubicacion mientras usas la app para centrar la simulacion cerca de ti.",
        );
      }
      let location: Location.LocationObject | null = null;
      try {
        location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
      } catch {
        location = await Location.getLastKnownPositionAsync({
          maxAge: 60_000,
          requiredAccuracy: 100,
        });
      }
      if (!location) {
        throw new Error(
          "No fue posible obtener tu posicion. Activa la ubicacion del telefono e intenta nuevamente.",
        );
      }
      return startOfflineSimulation({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracy: location.coords.accuracy,
      });
    });
  }, [run]);

  const confirmReset = useCallback(() => {
    Alert.alert(
      "Reiniciar simulacion",
      "Solo se borraran los datos falsos guardados en la base aislada de simulacion.",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Reiniciar",
          style: "destructive",
          onPress: () => {
            setShowSavedData(false);
            setShowEvidence(false);
            void run(resetOfflineSimulation);
          },
        },
      ],
    );
  }, [run]);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      visible={visible}
    >
      <View style={styles.screen}>
        <View
          style={[
            styles.topBar,
            compactLayout && styles.topBarCompact,
            { paddingTop: insets.top + 8 },
          ]}
        >
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.backButton}>
            <Text style={styles.backText}>‹ Volver</Text>
          </Pressable>
          <View style={styles.topTitleWrap}>
            <Text style={styles.brand}>PaintFoot.io</Text>
            <Text style={styles.topTitle}>Simulacion offline</Text>
          </View>
          <StatusPill label="PRUEBA" tone="active" />
        </View>

        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          <View style={[styles.heroCard, compactLayout && styles.heroCardCompact]}>
            <View style={styles.heroText}>
              <Text style={styles.eyebrow}>ESTADO ACTUAL</Text>
              <Text style={styles.heroStatus}>
                {state.forcedOffline ? "SIN INTERNET" : hasSession ? "CON INTERNET" : "LISTO PARA PROBAR"}
              </Text>
              <Text style={styles.heroHelp}>
                {hasSession && state.centerLatitude !== null
                  ? `Circuito centrado en tu GPS actual${state.centerAccuracy !== null ? ` · precision ±${Math.round(state.centerAccuracy)} m` : ""}. La partida real no cambia.`
                  : "La red se simula solo aqui. Al iniciar se usara tu GPS actual sin cambiar la partida real."}
              </Text>
            </View>
            <View style={[styles.networkDot, state.forcedOffline ? styles.offlineDot : styles.onlineDot]} />
          </View>

          <View style={styles.visualOnlyNotice}>
            <Text style={styles.visualOnlyTitle}>Prueba visual de desarrollo</Text>
            <Text style={styles.visualOnlyText}>
              Esta pantalla solo muestra una simulacion. En el recorrido normal, el modo offline se activa automaticamente cuando pierdes Internet y no requiere ningun boton adicional.
            </Text>
          </View>

          <View style={styles.mapCard}>
            <Text style={styles.sectionTitle}>Ruta de prueba</Text>
            <View
              style={[styles.mapFrame, { height: Math.max(180, Math.min(260, width * 0.62)) }]}
              pointerEvents="none"
            >
              <WebView
                originWhitelist={["*"]}
                source={{ html: mapHtml }}
                scrollEnabled={false}
                showsHorizontalScrollIndicator={false}
                showsVerticalScrollIndicator={false}
                style={styles.mapWebView}
              />
            </View>
          </View>

          <View style={styles.metricsGrid}>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>Recorrido</Text>
              <Text style={styles.metricValue}>{state.routeActive ? "Activo" : hasSession ? "Finalizado" : "Inactivo"}</Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>Guardado local</Text>
              <Text style={styles.metricValue}>{hasSession ? "SQLite OK" : "Preparado"}</Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>Puntos GPS</Text>
              <Text style={styles.metricValue}>{state.points.length} guardados</Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>Sync</Text>
              <Text style={styles.metricValue}>
                {state.syncStatus === "completed" ? "Completado" : state.syncStatus === "processing" ? "Procesando" : "Pendiente"}
              </Text>
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Ultimo punto guardado</Text>
            <View style={styles.dataRows}>
              <View style={styles.dataRow}><Text style={styles.dataLabel}>Latitud, longitud</Text><Text selectable style={styles.dataValue}>{latestPoint ? `${latestPoint.latitude.toFixed(6)}, ${latestPoint.longitude.toFixed(6)}` : "Esperando GPS"}</Text></View>
              <View style={styles.dataRow}><Text style={styles.dataLabel}>Secuencia</Text><Text style={styles.dataValue}>{latestPoint ? String(latestPoint.sequence).padStart(3, "0") : "---"}</Text></View>
              <View style={styles.dataRow}><Text style={styles.dataLabel}>Hora normal</Text><Text style={styles.dataValue}>{timeLabel(latestPoint?.wallClockTimestamp ?? null)}</Text></View>
              <View style={styles.dataRow}><Text style={styles.dataLabel}>Reloj monotonic</Text><Text style={styles.dataValue}>{latestPoint ? `${latestPoint.monotonicTimestamp.toFixed(1)} ms` : "Esperando"}</Text></View>
              <View style={styles.dataRow}><Text style={styles.dataLabel}>Fuente reloj</Text><Text style={styles.dataValue}>{latestPoint?.monotonicSource ?? "Esperando"}</Text></View>
              <View style={styles.dataRow}><Text style={styles.dataLabel}>Hash SHA-256</Text><Text selectable style={styles.hashValue}>{latestPoint ? latestPoint.currentHash.slice(0, 8) : "--------"}</Text></View>
            </View>
          </View>

          <View style={styles.card}>
            <View style={styles.cacheRow}>
              <View style={styles.cacheText}>
                <Text style={styles.sectionTitle}>Calles guardadas suficientes</Text>
                <Text style={styles.help}>Activalo para probar validacion local; desactivalo para probar pending_validation.</Text>
              </View>
              <Switch
                disabled={!hasSession || busy || state.territoryStatus !== "none"}
                value={state.cacheSufficient}
                onValueChange={(value) => void run(() => setOfflineSimulationCache(value))}
                trackColor={{ false: "#48506A", true: "#315E9E" }}
                thumbColor={state.cacheSufficient ? "#40C4FF" : "#B0B7CA"}
              />
            </View>
            <Text style={styles.territoryResult}>{territoryStatusLabel(state.territoryStatus)}</Text>
            <Text style={styles.fillHelp}>
              El interior se pinta con tu color global cuando la validacion offline o posterior queda confirmada.
            </Text>
          </View>

          <View style={styles.actionsCard}>
            <Text style={styles.sectionTitle}>Controles de simulacion</Text>
            <Pressable disabled={busy} onPress={startNearCurrentLocation} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy && styles.disabled]}>
              <Text style={styles.primaryButtonText}>Iniciar simulacion cerca de mi</Text>
            </Pressable>
            <View style={[styles.buttonPair, compactLayout && styles.buttonPairCompact]}>
              <Pressable disabled={busy || !state.routeActive || state.points.length >= SIMULATION_ROUTE.length} onPress={() => void run(addOfflineSimulationPoint)} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, (busy || !state.routeActive || state.points.length >= SIMULATION_ROUTE.length) && styles.disabled]}>
                <Text style={styles.secondaryButtonText}>Agregar punto GPS</Text>
              </Pressable>
              <Pressable disabled={busy || !state.routeActive} onPress={() => void run(closeOfflineSimulationPerimeter)} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, (busy || !state.routeActive) && styles.disabled]}>
                <Text style={styles.secondaryButtonText}>Cerrar perimetro</Text>
              </Pressable>
            </View>
            <Pressable disabled={busy || !hasSession || !state.forcedOffline} onPress={() => void run(restoreOfflineSimulationInternet)} style={({ pressed }) => [styles.syncButton, pressed && styles.pressed, (busy || !hasSession || !state.forcedOffline) && styles.disabled]}>
              <Text style={styles.primaryButtonText}>Simular regreso de Internet</Text>
            </Pressable>
            <View style={[styles.buttonPair, compactLayout && styles.buttonPairCompact]}>
              <Pressable disabled={busy || !hasSession} onPress={() => setShowSavedData((value) => !value)} style={({ pressed }) => [styles.tertiaryButton, pressed && styles.pressed, (busy || !hasSession) && styles.disabled]}>
                <Text style={styles.tertiaryButtonText}>{showSavedData ? "Ocultar datos" : "Ver datos guardados"}</Text>
              </Pressable>
              <Pressable disabled={busy || !hasSession} onPress={() => setShowEvidence(true)} style={({ pressed }) => [styles.tertiaryButton, pressed && styles.pressed, (busy || !hasSession) && styles.disabled]}>
                <Text style={styles.tertiaryButtonText}>Generar evidencia</Text>
              </Pressable>
            </View>
            <Pressable disabled={busy || !hasSession} onPress={confirmReset} style={({ pressed }) => [styles.resetButton, pressed && styles.pressed, (busy || !hasSession) && styles.disabled]}>
              <Text style={styles.resetButtonText}>Reiniciar simulacion</Text>
            </Pressable>
            {busy && <ActivityIndicator color="#40C4FF" />}
            {message && <Text style={styles.message}>{message}</Text>}
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Flujo de la prueba</Text>
            <View style={styles.pipeline}>
              {pipeline.map((step, index) => (
                <View key={step.label} style={styles.pipelineItem}>
                  <View style={styles.pipelineRail}>
                    <View style={[styles.stepDot, styles[`step_${step.status}`]]} />
                    {index < pipeline.length - 1 && <View style={styles.stepLine} />}
                  </View>
                  <View style={styles.stepTextWrap}>
                    <Text style={styles.stepLabel}>{step.label}</Text>
                    <Text style={styles.stepDetail}>{step.detail}</Text>
                  </View>
                  <Text style={[styles.stepStatus, styles[`stepText_${step.status}`]]}>{step.status}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Registro visual</Text>
            {state.logs.length === 0 ? (
              <Text style={styles.help}>Inicia una prueba para ver el registro.</Text>
            ) : state.logs.map((log) => (
              <Text key={log.id} style={styles.logLine}>{timeLabel(log.createdAt)} · {log.message}</Text>
            ))}
          </View>

          {showSavedData && (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Datos persistidos</Text>
              <Text selectable style={styles.mono}>simulationSessionId: {state.sessionId}</Text>
              <Text style={styles.mono}>base: paintfoot-offline-simulation.db</Text>
              <Text style={styles.mono}>puntos: {state.points.length}</Text>
              <Text style={styles.mono}>territorio: {state.territoryStatus}</Text>
              <Text style={styles.mono}>sync_queue simulada: {state.syncStatus}</Text>
              <Text style={styles.isolationNotice}>Base separada: no contiene tablas de territorios reales, ranking, pagos, escudos ni mundo global.</Text>
            </View>
          )}

          {showEvidence && (
            <View style={styles.evidenceCard}>
              <View style={styles.evidenceHeader}>
                <View><Text style={styles.evidenceBrand}>PaintFoot.io</Text><Text style={styles.evidenceTitle}>Simulacion offline</Text></View>
                <StatusPill label="EVIDENCIA" tone="good" />
              </View>
              <View style={styles.evidenceRule} />
              <Text style={styles.evidenceDate}>Fecha de prueba: {new Date().toLocaleString()}</Text>
              <View style={styles.evidenceRows}>
                <Text style={styles.evidenceRow}>Estado: {state.forcedOffline ? "Sin Internet" : "Con Internet simulado"}</Text>
                <Text style={styles.evidenceRow}>Puntos guardados: {state.points.length}</Text>
                <Text style={styles.evidenceRow}>SQLite: correcto</Text>
                <Text style={styles.evidenceRow}>Reloj interno: {latestPoint ? "activo" : "esperando"}</Text>
                <Text style={styles.evidenceRow}>Hash SHA-256: {latestPoint ? "correcto" : "esperando"}</Text>
                <Text style={styles.evidenceRow}>Sync queue: {state.syncStatus}</Text>
                <Text style={styles.evidenceRow}>Territorio: {state.territoryStatus}</Text>
              </View>
              <Text style={styles.evidenceFooter}>Reporte visual listo para captura · Datos 100% simulados</Text>
              <Pressable onPress={() => setShowEvidence(false)} style={styles.evidenceClose}><Text style={styles.tertiaryButtonText}>Cerrar reporte</Text></Pressable>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0C1020" },
  topBar: { minHeight: 78, paddingHorizontal: 15, paddingBottom: 12, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#151B31", borderBottomWidth: 1, borderBottomColor: "#293454" },
  topBarCompact: { flexWrap: "wrap", justifyContent: "space-between" },
  backButton: { minWidth: 68, minHeight: 42, justifyContent: "center" },
  backText: { color: "#72B8FF", fontSize: 14, fontWeight: "800" },
  topTitleWrap: { flex: 1, alignItems: "center" },
  brand: { color: "#40C4FF", fontSize: 12, fontWeight: "900" },
  topTitle: { color: "#FFFFFF", fontSize: 17, fontWeight: "900" },
  content: { width: "100%", maxWidth: 760, alignSelf: "center", padding: 15, gap: 15 },
  heroCard: { backgroundColor: "#171E36", borderRadius: 18, padding: 17, borderWidth: 1, borderColor: "#2B385D", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 15 },
  heroCardCompact: { alignItems: "flex-start", flexDirection: "column" },
  heroText: { flex: 1, minWidth: 0 },
  eyebrow: { color: "#8C97B8", fontSize: 10, fontWeight: "900", letterSpacing: 1.2 },
  heroStatus: { color: "#FFFFFF", fontSize: 25, fontWeight: "900", marginTop: 5 },
  heroHelp: { color: "#9FA9C5", fontSize: 11, lineHeight: 16, marginTop: 6, maxWidth: 270 },
  visualOnlyNotice: { backgroundColor: "#172944", borderRadius: 14, borderWidth: 1, borderColor: "#315B89", padding: 13, gap: 4 },
  visualOnlyTitle: { color: "#72D2FF", fontSize: 13, fontWeight: "900" },
  visualOnlyText: { color: "#B9C6DB", fontSize: 11, lineHeight: 17 },
  networkDot: { width: 19, height: 19, borderRadius: 10, borderWidth: 4 },
  offlineDot: { backgroundColor: "#FFB74D", borderColor: "#6B4D2E" },
  onlineDot: { backgroundColor: "#72E6BE", borderColor: "#285A4B" },
  card: { backgroundColor: "#171E36", borderRadius: 17, padding: 15, borderWidth: 1, borderColor: "#283455", gap: 11 },
  mapCard: { backgroundColor: "#171E36", borderRadius: 17, padding: 12, borderWidth: 1, borderColor: "#283455", gap: 10 },
  sectionTitle: { color: "#FFFFFF", fontSize: 16, fontWeight: "900" },
  mapFrame: { height: 220, overflow: "hidden", borderRadius: 13, backgroundColor: "#11182C" },
  mapWebView: { flex: 1, backgroundColor: "#11182C" },
  metricsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  metricCard: { minWidth: 130, flexBasis: "47%", flexGrow: 1, backgroundColor: "#171E36", borderRadius: 14, padding: 13, borderWidth: 1, borderColor: "#283455" },
  metricLabel: { color: "#8E99B9", fontSize: 11, fontWeight: "700" },
  metricValue: { color: "#72E6BE", fontSize: 14, fontWeight: "900", marginTop: 5 },
  dataRows: { gap: 10 },
  dataRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  dataLabel: { color: "#9EA8C4", fontSize: 12, flex: 1 },
  dataValue: { color: "#E9ECF5", fontSize: 12, fontWeight: "800", textAlign: "right", flex: 1.35 },
  hashValue: { color: "#80CBC4", fontFamily: "monospace", fontSize: 13, fontWeight: "900" },
  cacheRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  cacheText: { flex: 1, gap: 5 },
  help: { color: "#8E99B9", fontSize: 11, lineHeight: 16 },
  territoryResult: { color: "#FFE082", backgroundColor: "#24273C", borderRadius: 10, padding: 10, textAlign: "center", fontSize: 13, fontWeight: "900" },
  fillHelp: { color: "#8E99B9", fontSize: 10, lineHeight: 15, textAlign: "center" },
  actionsCard: { backgroundColor: "#171E36", borderRadius: 17, padding: 15, borderWidth: 1, borderColor: "#283455", gap: 10 },
  primaryButton: { minHeight: 49, borderRadius: 12, backgroundColor: "#2867C7", alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  syncButton: { minHeight: 49, borderRadius: 12, backgroundColor: "#168A70", alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  primaryButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "900", textAlign: "center" },
  buttonPair: { flexDirection: "row", gap: 9 },
  buttonPairCompact: { flexDirection: "column" },
  secondaryButton: { flex: 1, minHeight: 48, borderRadius: 12, backgroundColor: "#2B395D", alignItems: "center", justifyContent: "center", paddingHorizontal: 9 },
  secondaryButtonText: { color: "#FFFFFF", fontSize: 12, fontWeight: "900", textAlign: "center" },
  tertiaryButton: { flex: 1, minHeight: 44, borderRadius: 11, borderWidth: 1, borderColor: "#40527E", alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  tertiaryButtonText: { color: "#B9D8FF", fontSize: 12, fontWeight: "900", textAlign: "center" },
  resetButton: { minHeight: 42, alignItems: "center", justifyContent: "center" },
  resetButtonText: { color: "#FF8A80", fontSize: 12, fontWeight: "900" },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.42 },
  message: { color: "#FFCC80", fontSize: 12, textAlign: "center" },
  pipeline: { gap: 0 },
  pipelineItem: { minHeight: 58, flexDirection: "row", gap: 11 },
  pipelineRail: { width: 18, alignItems: "center" },
  stepDot: { width: 13, height: 13, borderRadius: 7, marginTop: 3, borderWidth: 2 },
  stepLine: { width: 2, flex: 1, backgroundColor: "#34405F", marginVertical: 3 },
  step_pending: { backgroundColor: "#343B51", borderColor: "#6E7897" },
  step_active: { backgroundColor: "#40C4FF", borderColor: "#A8E7FF" },
  step_completed: { backgroundColor: "#72E6BE", borderColor: "#B8FFE6" },
  step_error: { backgroundColor: "#FF6B6B", borderColor: "#FFC1C1" },
  stepTextWrap: { flex: 1 },
  stepLabel: { color: "#F2F4FA", fontSize: 13, fontWeight: "900" },
  stepDetail: { color: "#8E99B9", fontSize: 11, lineHeight: 16, marginTop: 2 },
  stepStatus: { fontSize: 10, fontWeight: "900", textTransform: "uppercase", marginTop: 2 },
  stepText_pending: { color: "#8E99B9" },
  stepText_active: { color: "#40C4FF" },
  stepText_completed: { color: "#72E6BE" },
  stepText_error: { color: "#FF8A80" },
  logLine: { color: "#CAD0E3", fontFamily: "monospace", fontSize: 11, lineHeight: 18 },
  mono: { color: "#80CBC4", fontFamily: "monospace", fontSize: 11, lineHeight: 18 },
  isolationNotice: { color: "#FFE082", fontSize: 11, lineHeight: 17, marginTop: 5 },
  evidenceCard: { backgroundColor: "#F7FAFF", borderRadius: 18, padding: 18, borderWidth: 2, borderColor: "#72B8FF", gap: 11 },
  evidenceHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  evidenceBrand: { color: "#1762A8", fontSize: 14, fontWeight: "900" },
  evidenceTitle: { color: "#11182C", fontSize: 22, fontWeight: "900" },
  evidenceRule: { height: 2, backgroundColor: "#D7E5F5" },
  evidenceDate: { color: "#56627A", fontSize: 11 },
  evidenceRows: { gap: 7 },
  evidenceRow: { color: "#1C2942", fontSize: 13, fontWeight: "700" },
  evidenceFooter: { color: "#68758C", fontSize: 10, textAlign: "center", marginTop: 5 },
  evidenceClose: { minHeight: 38, borderRadius: 10, backgroundColor: "#263B61", alignItems: "center", justifyContent: "center" },
  pill: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5 },
  pill_neutral: { backgroundColor: "#313950" },
  pill_active: { backgroundColor: "#173F66" },
  pill_good: { backgroundColor: "#D5F4E9" },
  pill_warning: { backgroundColor: "#57451D" },
  pillText: { fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  pillText_neutral: { color: "#C3CAE0" },
  pillText_active: { color: "#72D2FF" },
  pillText_good: { color: "#126149" },
  pillText_warning: { color: "#FFE082" },
});

