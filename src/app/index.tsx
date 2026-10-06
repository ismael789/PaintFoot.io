import Constants from "expo-constants";
import NetInfo from "@react-native-community/netinfo";
import { useFocusEffect } from "expo-router";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { TerritoryShieldPanel } from "@/components/territory-shield-panel";

import {
  appendStoredRoutePoints,
  BACKGROUND_LOCATION_TASK,
  beginStoredRouteSession,
  clearStoredRouteSession,
  getStoredRoutePoints,
  getStoredRouteSession,
  markStoredRouteActive,
  markStoredRoutePending,
  type StoredLocationPoint,
} from "@/services/background-location";
import {
  openLocationSettingsIntent,
  openNotificationSettingsIntent,
} from "@/services/android-intents";
import {
  registerForRemotePushNotifications,
  type PushRegistrationResult,
} from "@/services/push-notifications";
import {
  buildRoadGraph,
  getRoadMatchingWindow,
  matchTraceToRoads,
  mergeMatchedTrack,
  mergeRoadSegments,
} from "@/services/road-matching";
import {
  cacheRoadMatchResult,
  matchTraceFromRoadCache,
} from "@/services/road-cache";
import {
  getPendingTerritories,
  resolvePendingTerritory,
  savePendingTerritory,
  saveTrustedServerTime,
  verifySessionHashChain,
} from "@/services/offline-storage";
import { detectProvisionalOfflineCandidate } from "@/services/offline-validation";
import { MotionSensorTracker } from "@/services/motion-sensors";
import { AmbientThemeController } from "@/services/sensor-metrics";
import { sensorCapabilityManager } from "@/services/sensor-capabilities";
import {
  createTrackingSessionSummary,
  shouldAcceptRoadTransition,
} from "@/services/sensor-fusion";
import {
  getLatestTrackingSession,
  getThemePreference,
  saveThemePreference,
  saveTrackingSession,
} from "@/services/tracking-stats";
import {
  DEFAULT_PLAYER_PROFILE,
  getOrCreatePlayerProfile,
} from "@/services/player-profile";
import {
  createTerritoryFromLoop,
  detectClosedLoops,
} from "@/services/territory-detection";
import {
  appendStoredTerritories,
  getStoredTerritories,
  subscribeToStoredTerritories,
  updateStoredTerritory,
} from "@/services/territory-storage";
import { canPlayerConquerTerritory } from "@/services/territory-shields";
import {
  ROAD_MATCHING_RULES,
  TRACKING_RULES,
} from "@/config/territory";
import type {
  GeoCoordinate,
  PlayerProfile,
  RawTrackPoint,
  ResolvedTheme,
  RoadSegment,
  SensorEvidence,
  Territory,
  ThemePreference,
  TrackingSessionSummary,
} from "@/types/game";
import { debugLog } from "@/utils/debug-log";
import { distanceInMeters } from "@/utils/geo";
import { MAP_HTML } from "@/services/map-html";

// ─── Trail Config ────────────────────────────────────────────────
const TRAIL_COLOR = "#FF4444";
const TRAIL_STROKE_WIDTH = 5;
const IS_EXPO_GO = Constants.expoGoConfig !== null;

// ─── GPS Config ──────────────────────────────────────────────────
// Seguimiento moderado para mantener visible al jugador en el modo multijugador.
const GPS_OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.High,
  distanceInterval: 5, // Actualiza cada 5 metros
  timeInterval: 1000, // (Android) Mínimo 1 segundo entre actualizaciones
};

// ─── Coordenada type ─────────────────────────────────────────────
const REAL_TIME_GPS_OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.BestForNavigation,
  distanceInterval: 1,
  timeInterval: 500,
  mayShowUserSettingsDialog: true,
};

const BACKGROUND_GPS_OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.BestForNavigation,
  distanceInterval: 1,
  timeInterval: 1000,
  activityType: Location.ActivityType.Fitness,
  pausesUpdatesAutomatically: false,
  showsBackgroundLocationIndicator: true,
  foregroundService: {
    notificationTitle: "PaintFoot.io esta registrando tu recorrido",
    notificationBody: "El GPS seguira activo mientras conquistas territorio.",
    notificationColor: DEFAULT_PLAYER_PROFILE.color,
    killServiceOnDestroy: false,
  },
};

const MAX_ACCEPTABLE_ACCURACY_METERS = TRACKING_RULES.maxGpsAccuracyMeters;
const MINIMUM_POINT_DISTANCE_METERS =
  TRACKING_RULES.minimumPointDistanceMeters;
const MAX_ACCEPTABLE_SPEED_MPS = TRACKING_RULES.maxAcceptableSpeedMps;

type Coordinate = GeoCoordinate;

type BackgroundTrackingStatus =
  | "expo-go"
  | "inactive"
  | "requesting"
  | "active"
  | "denied"
  | "unavailable";

type PushStatus = "registering" | PushRegistrationResult["status"];

type RoadMatchStatus = "idle" | "waiting" | "matching" | "ready" | "error";

const BACKGROUND_STATUS_LABEL: Record<BackgroundTrackingStatus, string> = {
  "expo-go": "Segundo plano: disponible solo en el APK",
  inactive: "Segundo plano: listo para iniciar",
  requesting: "Segundo plano: esperando permiso",
  active: "Segundo plano: GPS activo",
  denied: "Segundo plano: permiso denegado",
  unavailable: "Segundo plano: no disponible en este dispositivo",
};

const PUSH_STATUS_LABEL: Record<PushStatus, string> = {
  registering: "Push: registrando dispositivo",
  registered: "Push: activo",
  "expo-go-unsupported": "Push: disponible solo en el APK",
  "physical-device-required": "Push: requiere un telefono fisico",
  "permission-denied": "Push: permiso denegado",
  "missing-project-id": "Push: falta vincular el proyecto EAS",
  "registration-error": "Push: error de registro",
};

const ROAD_STATUS_LABEL: Record<RoadMatchStatus, string> = {
  idle: "Calles: listas para iniciar",
  waiting: "Calles: esperando puntos GPS",
  matching: "Calles: ajustando recorrido",
  ready: "Calles: recorrido ajustado",
  error: "Sin conexion vial: recorrido guardado y pendiente",
};

function confirmBackgroundLocation() {
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      "Ubicacion durante el recorrido",
      "PaintFoot.io necesita acceso a la ubicacion en segundo plano para seguir registrando tu ruta si bloqueas la pantalla o cambias de aplicacion.",
      [
        {
          text: "Ahora no",
          style: "cancel",
          onPress: () => resolve(false),
        },
        { text: "Continuar", onPress: () => resolve(true) },
      ],
      { cancelable: false },
    );
  });
}

function sendPlayerLocation(
  socket: WebSocket | null,
  playerId: string,
  coordinate: Coordinate,
  color: string,
) {
  if (!playerId || socket?.readyState !== WebSocket.OPEN) return;

  socket.send(
    JSON.stringify({
      type: "location",
      id: playerId,
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      color,
    }),
  );
}

function sendPushToken(
  socket: WebSocket | null,
  playerId: string,
  token: string,
) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "push-token", id: playerId, token }));
}

function getWebSocketUrl() {
  const configuredUrl = process.env.EXPO_PUBLIC_WS_URL?.trim();
  if (configuredUrl) return configuredUrl;

  const hostUri = Constants.expoConfig?.hostUri;
  if (!hostUri) return null;

  return `ws://${hostUri.split(":")[0]}:8082`;
}

const DEFAULT_REGION = {
  latitude: 19.4326, // CDMX como fallback
  longitude: -99.1332,
  latitudeDelta: 0.01,
  longitudeDelta: 0.01,
};

function formatDuration(durationMs: number) {
  const totalMinutes = Math.max(0, Math.round(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

async function matchCompletePendingTrack(rawTrack: RawTrackPoint[]) {
  let matchedRawCount = 0;
  let snappedTrack: GeoCoordinate[] = [];
  let segments: RoadSegment[] = [];

  while (matchedRawCount < rawTrack.length) {
    const range = getRoadMatchingWindow(rawTrack.length, matchedRawCount);
    const window = rawTrack.slice(range.start, range.end);
    const result = await matchTraceToRoads(window);
    await cacheRoadMatchResult(result);
    if (result.serverTimeMs) await saveTrustedServerTime(result.serverTimeMs);
    snappedTrack =
      range.start === 0
        ? result.snappedTrack
        : mergeMatchedTrack(snappedTrack, result.snappedTrack);
    segments =
      range.start === 0
        ? result.segments
        : mergeRoadSegments(segments, result.segments);
    if (range.end <= matchedRawCount) break;
    matchedRawCount = range.end;
  }

  return { snappedTrack, segments, matchedRawCount };
}

export default function MapScreen() {
  // ─── State ───────────────────────────────────────────────────
  const [location, setLocation] = useState<Coordinate | null>(null);
  const [routeCoords, setRouteCoords] = useState<Coordinate[]>([]);
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [territoriesLoaded, setTerritoriesLoaded] = useState(false);
  const [playerProfile, setPlayerProfile] = useState<PlayerProfile>(
    DEFAULT_PLAYER_PROFILE,
  );
  const [roadMatchStatus, setRoadMatchStatus] =
    useState<RoadMatchStatus>("idle");
  const [rawPointCount, setRawPointCount] = useState(0);
  const [roadSegmentCount, setRoadSegmentCount] = useState(0);
  const [intersectionCount, setIntersectionCount] = useState(0);
  const [totalAreaM2, setTotalAreaM2] = useState(0);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [mapStatus, setMapStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [isTracking, setIsTracking] = useState(false);
  const [hasPendingSavedRoute, setHasPendingSavedRoute] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [hasLocationPermission, setHasLocationPermission] = useState(false);
  const [backgroundTrackingStatus, setBackgroundTrackingStatus] =
    useState<BackgroundTrackingStatus>(IS_EXPO_GO ? "expo-go" : "inactive");
  const [pushStatus, setPushStatus] = useState<PushStatus>(
    IS_EXPO_GO ? "expo-go-unsupported" : "registering",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sensorEvidence, setSensorEvidence] = useState<SensorEvidence | null>(
    null,
  );
  const [themePreference, setThemePreference] =
    useState<ThemePreference>("auto");
  const [resolvedTheme, setResolvedTheme] =
    useState<ResolvedTheme>("dark");
  const [latestSession, setLatestSession] =
    useState<TrackingSessionSummary | null>(null);
  const myPlayerId = playerProfile.id;

  // ─── Refs ────────────────────────────────────────────────────
  const mapRef = useRef<WebView>(null);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const passiveSubscriptionRef =
    useRef<Location.LocationSubscription | null>(null);
  const lastAcceptedCoordinateRef = useRef<Coordinate | null>(null);
  const routeCoordsRef = useRef<Coordinate[]>([]);
  const rawTrackRef = useRef<RawTrackPoint[]>([]);
  const roadSegmentsRef = useRef<RoadSegment[]>([]);
  const motionSensorTrackerRef = useRef(new MotionSensorTracker());
  const territorySignaturesRef = useRef(new Set<string>());
  const lastAnalyzedSegmentRef = useRef(1);
  const lastMatchedRawCountRef = useRef(0);
  const lastRoadMatchAtRef = useRef(0);
  const roadMatchInFlightRef = useRef(false);
  const roadMatchQueuedRef = useRef(false);
  const roadMatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackingGenerationRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const isTrackingRef = useRef(false);
  const territoriesRef = useRef<Territory[]>([]);
  const latestLocationRef = useRef<Coordinate | null>(null);
  const pushTokenRef = useRef<string | null>(null);
  const ambientThemeControllerRef = useRef(new AmbientThemeController("dark"));
  const sessionStartedAtRef = useRef(0);
  const sessionTerritoryCountRef = useRef(0);
  const sessionAreaM2Ref = useRef(0);
  const isOnlineRef = useRef(true);
  const pendingSyncInFlightRef = useRef(false);

  useEffect(() => {
    isTrackingRef.current = isTracking;
  }, [isTracking]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected =
        state.isConnected !== false && state.isInternetReachable !== false;
      isOnlineRef.current = connected;
      setIsOnline(connected);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getThemePreference(), getLatestTrackingSession()]).then(
      ([preference, summary]) => {
        if (cancelled) return;
        setThemePreference(preference);
        if (preference !== "auto") setResolvedTheme(preference);
        setLatestSession(summary);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (themePreference !== "auto") {
      void motionSensorTrackerRef.current.setAmbientLightEnabled(false);
      setResolvedTheme(themePreference);
      return;
    }

    let cancelled = false;
    void motionSensorTrackerRef.current.setAmbientLightEnabled(
      true,
      (illuminanceLux, proximityNear) => {
        if (cancelled) return;
        setResolvedTheme(
          ambientThemeControllerRef.current.update(
            "auto",
            illuminanceLux,
            Date.now(),
            proximityNear,
          ),
        );
      },
    );
    return () => {
      cancelled = true;
      void motionSensorTrackerRef.current.setAmbientLightEnabled(false);
    };
  }, [themePreference]);

  const selectTheme = useCallback((preference: ThemePreference) => {
    setThemePreference(preference);
    if (preference !== "auto") {
      setResolvedTheme(
        ambientThemeControllerRef.current.update(preference, 0),
      );
    }
    void saveThemePreference(preference);
  }, []);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    void getOrCreatePlayerProfile().then((profile) => {
      if (!cancelled) setPlayerProfile(profile);
    });
    return () => {
      cancelled = true;
    };
  }, []));

  useEffect(() => {
    let cancelled = false;
    void getStoredTerritories().then((storedTerritories) => {
      if (cancelled) return;
      territorySignaturesRef.current = new Set(
        storedTerritories.map((territory) => territory.signature),
      );
      setTerritories(storedTerritories);
      setTerritoriesLoaded(true);
      setTotalAreaM2(
        storedTerritories.reduce(
          (total, territory) => total + territory.areaM2,
          0,
        ),
      );
      debugLog(
        "TERRITORY",
        `${storedTerritories.length} territorio(s) restaurado(s).`,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Conexión WebSocket ──────────────────────────────────────
  useEffect(() => {
    if (!myPlayerId || !territoriesLoaded) return;

    let ws: WebSocket | null = null;
    try {
      const wsUrl = getWebSocketUrl();
      if (wsUrl) {
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log("Conectado al servidor WebSocket local:", wsUrl);
          ws?.send(JSON.stringify({ type: "player-hello", id: myPlayerId }));
          if (latestLocationRef.current) {
            sendPlayerLocation(
              ws,
              myPlayerId,
              latestLocationRef.current,
              playerProfile.color,
            );
          }
          if (pushTokenRef.current) {
            sendPushToken(ws, myPlayerId, pushTokenRef.current);
          }
          ws?.send(JSON.stringify({
            type: "territory-sync",
            id: myPlayerId,
            territoryIds: territoriesRef.current
              .filter((territory) => territory.playerId === myPlayerId)
              .map((territory) => territory.id),
          }));
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "location" && data.id !== myPlayerId) {
              mapRef.current?.injectJavaScript(
                `window.setOtherPlayerLocation('${data.id}', ${data.latitude}, ${data.longitude}, '${data.color || "#FF8800"}'); true;`,
              );
            }
          } catch (e) {
            console.warn("Error parseando mensaje WS:", e);
          }
        };

        ws.onerror = () => {
          // El servidor WebSocket es opcional (modo multijugador local).
          // Si no está corriendo, la app funciona normalmente en modo individual.
          console.log(
            "[WS] Servidor no disponible en el puerto 8082. Modo individual activo.",
          );
        };
      } else {
        console.warn(
          "No se configuro EXPO_PUBLIC_WS_URL y no se pudo determinar la IP local.",
        );
      }
    } catch (e) {
      console.warn("No se pudo inicializar WebSocket:", e);
    }

    return () => {
      if (ws) {
        ws.close();
      }
    };
  }, [myPlayerId, playerProfile.color]);

  useEffect(() => {
    territoriesRef.current = territories;
    if (wsRef.current?.readyState === WebSocket.OPEN && myPlayerId) {
      wsRef.current.send(JSON.stringify({
        type: "territory-sync",
        id: myPlayerId,
        territoryIds: territories
          .filter((territory) => territory.playerId === myPlayerId)
          .map((territory) => territory.id),
      }));
    }
  }, [myPlayerId, territories]);

  const launchLocationSettings = useCallback(async () => {
    try {
      await openLocationSettingsIntent();
    } catch (error) {
      console.warn("No se pudieron abrir los ajustes de ubicacion:", error);
      setErrorMsg("No se pudieron abrir los ajustes de ubicacion.");
    }
  }, []);

  const launchNotificationSettings = useCallback(async () => {
    try {
      await openNotificationSettingsIntent();
    } catch (error) {
      console.warn("No se pudieron abrir los ajustes de notificaciones:", error);
    }
  }, []);

  useEffect(() => {
    if (!myPlayerId) return;

    let cancelled = false;

    void registerForRemotePushNotifications().then((result) => {
      if (cancelled) return;

      setPushStatus(result.status);
      if (result.status === "registered") {
        pushTokenRef.current = result.token;
        sendPushToken(wsRef.current, myPlayerId, result.token);
      } else if (result.status === "registration-error") {
        console.warn("No se pudo registrar push:", result.message);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [myPlayerId]);

  // ─── Limpiar suscripción al desmontar ────────────────────────
  useEffect(() => {
    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current.remove();
        subscriptionRef.current = null;
      }
      if (passiveSubscriptionRef.current) {
        passiveSubscriptionRef.current.remove();
        passiveSubscriptionRef.current = null;
      }
      if (roadMatchTimerRef.current) {
        clearTimeout(roadMatchTimerRef.current);
        roadMatchTimerRef.current = null;
      }
      trackingGenerationRef.current += 1;
      motionSensorTrackerRef.current.stop();
    };
  }, []);

  // ─── Iniciar recorrido ───────────────────────────────────────
  const retryLocationPermission = useCallback(async () => {
    setErrorMsg(null);
    setIsLoading(true);

    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        setHasLocationPermission(false);
        setErrorMsg(
          permission.canAskAgain
            ? "Permiso de ubicacion denegado. Intenta nuevamente."
            : "El permiso fue bloqueado. Activalo para Expo Go desde la configuracion del telefono.",
        );
        return;
      }

      const currentLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.BestForNavigation,
      });
      const coords = {
        latitude: currentLocation.coords.latitude,
        longitude: currentLocation.coords.longitude,
        timestamp: currentLocation.timestamp,
      };
      setGpsAccuracy(currentLocation.coords.accuracy);
      sensorCapabilityManager.publishGps(
        true,
        currentLocation.coords.accuracy,
      );
      setLocation(coords);
      latestLocationRef.current = coords;
      setHasLocationPermission(true);
      sendPlayerLocation(
        wsRef.current,
        myPlayerId,
        coords,
        playerProfile.color,
      );
      mapRef.current?.injectJavaScript(
        `window.setUserLocation(${coords.latitude}, ${coords.longitude}, true); true;`,
      );
    } catch {
      setErrorMsg(
        "No se pudo obtener la ubicacion. Verifica que el GPS este activado.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [myPlayerId, playerProfile.color]);

  // Solicitar permiso y centrar el mapa al abrir la pantalla.
  useEffect(() => {
    void retryLocationPermission();
  }, [retryLocationPermission]);

  // Mantener la posición multijugador actualizada cuando no se graba un recorrido.
  useEffect(() => {
    if (!hasLocationPermission || isTracking) return;

    let cancelled = false;

    const startPassiveTracking = async () => {
      try {
        const subscription = await Location.watchPositionAsync(
          GPS_OPTIONS,
          (newLocation) => {
            const reportedAccuracy = newLocation.coords.accuracy;
            setGpsAccuracy(reportedAccuracy);
            sensorCapabilityManager.publishGps(true, reportedAccuracy);

            if (
              reportedAccuracy !== null &&
              reportedAccuracy > MAX_ACCEPTABLE_ACCURACY_METERS
            ) {
              return;
            }

            const newCoord: Coordinate = {
              latitude: newLocation.coords.latitude,
              longitude: newLocation.coords.longitude,
              timestamp: newLocation.timestamp,
            };

            latestLocationRef.current = newCoord;
            setLocation(newCoord);
            sendPlayerLocation(
              wsRef.current,
              myPlayerId,
              newCoord,
              playerProfile.color,
            );
            mapRef.current?.injectJavaScript(
              `window.setUserLocation(${newCoord.latitude}, ${newCoord.longitude}, false); true;`,
            );
          },
          (reason) => {
            if (!cancelled) {
              setErrorMsg(`Error de seguimiento GPS: ${reason}`);
            }
          },
        );

        if (cancelled) {
          subscription.remove();
          return;
        }

        passiveSubscriptionRef.current = subscription;
      } catch {
        if (!cancelled) {
          setErrorMsg("No se pudo iniciar la ubicacion multijugador.");
        }
      }
    };

    void startPassiveTracking();

    return () => {
      cancelled = true;
      if (passiveSubscriptionRef.current) {
        passiveSubscriptionRef.current.remove();
        passiveSubscriptionRef.current = null;
      }
    };
  }, [hasLocationPermission, isTracking, myPlayerId, playerProfile.color]);

  const recordDetectedTerritories = useCallback(
    (snappedTrack: Coordinate[], analyzeFromSegment: number) => {
      debugLog("LOOP", "Comprobando circuitos sobre segmentos viales.");
      const loops = detectClosedLoops(
        snappedTrack,
        analyzeFromSegment,
        undefined,
        {
          currentSessionSegments: roadSegmentsRef.current,
          rawTrack: rawTrackRef.current,
        },
      );
      const createdAt = Date.now();
      const newTerritories = loops
        .filter((loop) => {
          const existing = territoriesRef.current.find(
            (territory) => territory.signature === loop.signature,
          );
          if (!existing || existing.playerId === myPlayerId) return !existing;
          const conquerable = canPlayerConquerTerritory(
            existing,
            myPlayerId,
            createdAt,
          );
          if (!conquerable) {
            debugLog("TERRITORY", "Conquista bloqueada: territorio con escudo activo.");
          }
          return conquerable;
        })
        .map<Territory>((loop, index) =>
          createTerritoryFromLoop(
            loop,
            playerProfile,
            createdAt + index,
            index,
          ),
        );

      if (newTerritories.length === 0) return;

      sessionTerritoryCountRef.current += newTerritories.length;
      sessionAreaM2Ref.current += newTerritories.reduce(
        (total, territory) => total + territory.areaM2,
        0,
      );

      for (const territory of newTerritories) {
        territorySignaturesRef.current.add(territory.signature);
        debugLog("LOOP", "Circuito cerrado y valido detectado.");
        debugLog(
          "TERRITORY",
          `Poligono creado: ${Math.round(territory.areaM2)} m².`,
        );

        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: "territory-captured",
              id: myPlayerId,
              owner: territory.owner,
              territoryId: territory.id,
            }),
          );
        }
      }

      setTerritories((previousTerritories) => {
        const bySignature = new Map(
          previousTerritories.map((territory) => [territory.signature, territory]),
        );
        newTerritories.forEach((territory) => bySignature.set(territory.signature, territory));
        const next = [...bySignature.values()];
        setTotalAreaM2(next.reduce((total, territory) => total + territory.areaM2, 0));
        return next;
      });
      void appendStoredTerritories(newTerritories)
        .then(() => {
          debugLog("TERRITORY", "Guardado correctamente.");
        })
        .catch((error) => {
          console.warn("No se pudieron guardar los territorios:", error);
        });
    },
    [myPlayerId, playerProfile.color, playerProfile.name],
  );

  const runRoadMatchRef = useRef<(force?: boolean) => Promise<boolean>>(
    async () => false,
  );

  const runRoadMatch = useCallback(
    async (force = false) => {
      if (roadMatchInFlightRef.current) {
        roadMatchQueuedRef.current = true;
        return false;
      }

      const rawTrack = rawTrackRef.current;
      if (rawTrack.length < 2) {
        setRoadMatchStatus(rawTrack.length === 0 ? "idle" : "waiting");
        return false;
      }

      const newPointCount = rawTrack.length - lastMatchedRawCountRef.current;
      const elapsed = Date.now() - lastRoadMatchAtRef.current;
      if (
        !force &&
        newPointCount < ROAD_MATCHING_RULES.batchPointCount &&
        elapsed < ROAD_MATCHING_RULES.minimumRequestIntervalMs
      ) {
        return false;
      }

      roadMatchInFlightRef.current = true;
      setRoadMatchStatus("matching");
      lastRoadMatchAtRef.current = Date.now();
      const generation = trackingGenerationRef.current;
      const matchingRange = getRoadMatchingWindow(
        rawTrack.length,
        lastMatchedRawCountRef.current,
      );
      const capturedRawCount = matchingRange.end;
      const windowStart = matchingRange.start;
      const matchingWindow = rawTrack.slice(windowStart, capturedRawCount);

      try {
        let result;
        let networkError: unknown = null;
        if (isOnlineRef.current) {
          try {
            result = await matchTraceToRoads(matchingWindow);
            await cacheRoadMatchResult(result);
            if (result.serverTimeMs) {
              await saveTrustedServerTime(result.serverTimeMs);
            }
          } catch (error) {
            networkError = error;
          }
        }
        if (!result) {
          result = await matchTraceFromRoadCache(matchingWindow);
        }
        if (!result) {
          throw networkError ?? new Error("No hay calles guardadas suficientes para validar este recorrido.");
        }
        if (generation !== trackingGenerationRef.current) return false;

        if (
          windowStart > 0 &&
          !shouldAcceptRoadTransition(
            roadSegmentsRef.current.at(-1),
            result.segments.at(-1),
            matchingWindow,
          )
        ) {
          setRoadMatchStatus("waiting");
          debugLog(
            "ROAD",
            "Cambio de calle aplazado: falta evidencia GPS y de giro consistente.",
          );
          return false;
        }

        const nextTrack =
          windowStart === 0
            ? result.snappedTrack
            : mergeMatchedTrack(routeCoordsRef.current, result.snappedTrack);
        const nextSegments =
          windowStart === 0
            ? result.segments
            : mergeRoadSegments(roadSegmentsRef.current, result.segments);
        const graph = buildRoadGraph(nextSegments);
        const analyzeFromSegment =
          windowStart === 0
            ? 1
            : Math.max(
                1,
                Math.min(
                  lastAnalyzedSegmentRef.current - 20,
                  nextTrack.length - 2,
                ),
              );

        routeCoordsRef.current = nextTrack;
        roadSegmentsRef.current = nextSegments;
        lastMatchedRawCountRef.current = capturedRawCount;
        lastRoadMatchAtRef.current = Date.now();
        lastAnalyzedSegmentRef.current = Math.max(1, nextTrack.length - 2);
        setRouteCoords(nextTrack);
        setRoadSegmentCount(graph.segments.length);
        setIntersectionCount(graph.intersectionCount);
        setRoadMatchStatus("ready");
        if (result.source === "cache") {
          debugLog("ROAD", "Recorrido validado con calles guardadas en el dispositivo.");
        }
        debugLog(
          "NODE",
          `${graph.nodes.length} nodos; ${graph.intersectionCount} intersecciones recorridas.`,
        );
        recordDetectedTerritories(nextTrack, analyzeFromSegment);
        if (capturedRawCount < rawTrackRef.current.length) {
          roadMatchQueuedRef.current = true;
        }
        return true;
      } catch (error) {
        if (generation !== trackingGenerationRef.current) return false;
        setRoadMatchStatus("error");
        console.warn(
          "[ROAD] No se pudo ajustar el lote a calles; los puntos quedan pendientes:",
          error,
        );
        return false;
      } finally {
        roadMatchInFlightRef.current = false;
        if (
          generation === trackingGenerationRef.current &&
          roadMatchQueuedRef.current
        ) {
          roadMatchQueuedRef.current = false;
          setTimeout(() => {
            void runRoadMatchRef.current(true);
          }, 0);
        }
      }
    },
    [recordDetectedTerritories],
  );

  useEffect(() => {
    runRoadMatchRef.current = runRoadMatch;
  }, [runRoadMatch]);

  const synchronizePendingRoutes = useCallback(async () => {
    if (!isOnlineRef.current || pendingSyncInFlightRef.current) return;
    pendingSyncInFlightRef.current = true;
    try {
      const pendingRecords = await getPendingTerritories();
      for (const pending of pendingRecords) {
        const intact = await verifySessionHashChain(pending.sessionId);
        if (!intact) {
          console.warn(
            `[Offline] La cadena de eventos de ${pending.sessionId} no es valida.`,
          );
          await resolvePendingTerritory(pending.id, "rejected");
          continue;
        }

        try {
          const matched = await matchCompletePendingTrack(pending.rawTrack);
          if (matched.matchedRawCount < pending.rawTrack.length) continue;
          const loops = detectClosedLoops(matched.snappedTrack, 1, undefined, {
            currentSessionSegments: matched.segments,
            rawTrack: pending.rawTrack,
          });
          const createdAt = Date.now();
          const newTerritories = loops.flatMap<Territory>((loop, index) => {
            const existing = territoriesRef.current.find(
              (territory) => territory.signature === loop.signature,
            );
            if (existing?.playerId === myPlayerId) return [];
            if (
              existing &&
              !canPlayerConquerTerritory(existing, myPlayerId, createdAt)
            ) {
              return [];
            }
            return [
              createTerritoryFromLoop(
                loop,
                playerProfile,
                createdAt + index,
                index,
              ),
            ];
          });
          if (newTerritories.length > 0) {
            const stored = await appendStoredTerritories(newTerritories);
            territoriesRef.current = stored;
            setTerritories(stored);
            setTotalAreaM2(
              stored.reduce((total, territory) => total + territory.areaM2, 0),
            );
          }
          await resolvePendingTerritory(
            pending.id,
            loops.length > 0 ? "confirmed" : "rejected",
          );
        } catch (error) {
          console.warn("[Offline] La validacion pendiente se reintentara:", error);
          break;
        }
      }
      const remaining = await getPendingTerritories();
      setHasPendingSavedRoute(remaining.length > 0);
    } finally {
      pendingSyncInFlightRef.current = false;
    }
  }, [myPlayerId, playerProfile]);

  useEffect(() => {
    if (!isOnline) return;
    void synchronizePendingRoutes();
    if (rawTrackRef.current.length >= 2) {
      void runRoadMatchRef.current(true);
    }
  }, [isOnline, synchronizePendingRoutes]);

  const scheduleRoadMatch = useCallback((force = false) => {
    if (roadMatchTimerRef.current) {
      clearTimeout(roadMatchTimerRef.current);
    }

    const elapsed = Date.now() - lastRoadMatchAtRef.current;
    const delay = force
      ? 0
      : Math.max(
          0,
          ROAD_MATCHING_RULES.minimumRequestIntervalMs - elapsed,
        );

    setRoadMatchStatus((status) =>
      status === "matching" ? status : "waiting",
    );
    roadMatchTimerRef.current = setTimeout(() => {
      roadMatchTimerRef.current = null;
      void runRoadMatchRef.current(force);
    }, delay);
  }, []);

  const processRoutePoint = useCallback(
    (
      point: StoredLocationPoint,
      persist = true,
      sensor?: SensorEvidence,
    ) => {
      setGpsAccuracy(point.accuracy);
      sensorCapabilityManager.publishGps(true, point.accuracy);

      const persistPoint = (accepted: boolean) => {
        if (!persist) return;
        void appendStoredRoutePoints(
          [{ ...point, sensor, accepted }],
          !isOnlineRef.current,
        ).catch((error) => {
          console.warn("No se pudo guardar el punto GPS:", error);
        });
      };

      if (
        point.accuracy !== null &&
        point.accuracy > MAX_ACCEPTABLE_ACCURACY_METERS
      ) {
        persistPoint(false);
        return false;
      }

      const newCoord: Coordinate = {
        latitude: point.latitude,
        longitude: point.longitude,
        timestamp: point.timestamp,
      };
      const previousCoordinate = lastAcceptedCoordinateRef.current;

      if (previousCoordinate) {
        const distance = distanceInMeters(previousCoordinate, newCoord);

        if (distance < MINIMUM_POINT_DISTANCE_METERS) {
          persistPoint(false);
          return false;
        }

        if (
          previousCoordinate.timestamp !== undefined &&
          newCoord.timestamp !== undefined
        ) {
          const elapsedSeconds =
            (newCoord.timestamp - previousCoordinate.timestamp) / 1000;
          const calculatedSpeed = distance / elapsedSeconds;

          if (
            elapsedSeconds > 0 &&
            calculatedSpeed > MAX_ACCEPTABLE_SPEED_MPS
          ) {
            persistPoint(false);
            return false;
          }
        }
      }

      lastAcceptedCoordinateRef.current = newCoord;
      latestLocationRef.current = newCoord;
      rawTrackRef.current = [
        ...rawTrackRef.current,
        {
          ...newCoord,
          accuracy: point.accuracy,
          heading: point.heading,
          speed: point.speed,
          sensor,
        },
      ];
      setLocation(newCoord);
      setRawPointCount(rawTrackRef.current.length);
      const pendingCoordinates = rawTrackRef.current
        .slice(lastMatchedRawCountRef.current)
        .map(({ latitude, longitude, timestamp }) => ({
          latitude,
          longitude,
          timestamp,
        }));
      setRouteCoords(
        routeCoordsRef.current.length > 0
          ? [...routeCoordsRef.current, ...pendingCoordinates]
          : rawTrackRef.current.map(({ latitude, longitude, timestamp }) => ({
              latitude,
              longitude,
              timestamp,
            })),
      );
      persistPoint(true);

      mapRef.current?.injectJavaScript(
        `window.setUserLocation(${newCoord.latitude}, ${newCoord.longitude}, false); true;`,
      );
      sendPlayerLocation(
        wsRef.current,
        myPlayerId,
        newCoord,
        playerProfile.color,
      );
      if (
        rawTrackRef.current.length === 1 ||
        rawTrackRef.current.length % 5 === 0
      ) {
        debugLog(
          "GPS",
          `Punto aceptado (${rawTrackRef.current.length}); precision ${Math.round(
            point.accuracy ?? 0,
          )} m.`,
        );
      }
      scheduleRoadMatch();

      return true;
    },
    [myPlayerId, playerProfile.color, scheduleRoadMatch],
  );

  const importStoredRoutePoints = useCallback(async () => {
    const storedPoints = await getStoredRoutePoints();
    const lastTimestamp = lastAcceptedCoordinateRef.current?.timestamp ?? 0;

    storedPoints
      .filter((point) => point.timestamp > lastTimestamp)
      .sort((first, second) => first.timestamp - second.timestamp)
      .forEach((point) => processRoutePoint(point, false));
  }, [processRoutePoint]);

  useEffect(() => {
    if (!myPlayerId) return;
    let cancelled = false;

    void Promise.all([getStoredRouteSession(), getStoredRoutePoints()]).then(
      async ([session, storedPoints]) => {
        const recoveredSession =
          session ??
          (storedPoints.length >= 2
            ? await beginStoredRouteSession(
                myPlayerId,
                storedPoints[0]?.timestamp ?? Date.now(),
              )
            : null);
        if (
          cancelled ||
          !recoveredSession ||
          recoveredSession.playerId !== myPlayerId ||
          storedPoints.length < 2 ||
          rawTrackRef.current.length > 0
        ) {
          return;
        }

        const orderedPoints = [...storedPoints].sort(
          (first, second) => first.timestamp - second.timestamp,
        );
        rawTrackRef.current = orderedPoints.map((point) => ({ ...point }));
        const rawCoordinates = orderedPoints.map(
          ({ latitude, longitude, timestamp }) => ({
            latitude,
            longitude,
            timestamp,
          }),
        );
        const lastPoint = orderedPoints.at(-1)!;
        lastAcceptedCoordinateRef.current = rawCoordinates.at(-1)!;
        latestLocationRef.current = rawCoordinates.at(-1)!;
        sessionStartedAtRef.current = recoveredSession.startedAt;
        lastMatchedRawCountRef.current = 0;
        routeCoordsRef.current = [];
        roadSegmentsRef.current = [];
        setLocation(rawCoordinates.at(-1)!);
        setGpsAccuracy(lastPoint.accuracy);
        setRawPointCount(orderedPoints.length);
        setRouteCoords(rawCoordinates);
        setHasPendingSavedRoute(true);
        setRoadMatchStatus("waiting");
        debugLog(
          "GPS",
          `Recorrido local restaurado (${orderedPoints.length} puntos pendientes).`,
        );
        scheduleRoadMatch(true);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [myPlayerId, scheduleRoadMatch, territoriesLoaded]);

  useEffect(() => {
    if (roadMatchStatus !== "error" || rawTrackRef.current.length < 2) return;
    const retry = () => void runRoadMatchRef.current(true);
    const timer = setInterval(retry, 15_000);
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") retry();
    });
    return () => {
      clearInterval(timer);
      appStateSubscription.remove();
    };
  }, [roadMatchStatus]);

  useEffect(() => {
    if (
      isTracking ||
      !hasPendingSavedRoute ||
      roadMatchStatus !== "ready" ||
      lastMatchedRawCountRef.current < rawTrackRef.current.length
    ) {
      return;
    }
    void clearStoredRouteSession().then(() => {
      setHasPendingSavedRoute(false);
      debugLog("ROAD", "Recorrido pendiente recuperado y validado.");
    });
  }, [hasPendingSavedRoute, isTracking, roadMatchStatus]);

  const enableBackgroundTracking = useCallback(async () => {
    if (IS_EXPO_GO) {
      setBackgroundTrackingStatus("expo-go");
      return false;
    }

    if (Platform.OS !== "android") {
      setBackgroundTrackingStatus("unavailable");
      return false;
    }

    try {
      const taskManagerAvailable = await TaskManager.isAvailableAsync();
      const backgroundLocationAvailable =
        await Location.isBackgroundLocationAvailableAsync();

      if (!taskManagerAvailable || !backgroundLocationAvailable) {
        setBackgroundTrackingStatus("unavailable");
        return false;
      }

      let permission = await Location.getBackgroundPermissionsAsync();
      if (permission.status !== "granted") {
        const accepted = await confirmBackgroundLocation();
        if (!accepted) {
          setBackgroundTrackingStatus("denied");
          return false;
        }

        setBackgroundTrackingStatus("requesting");
        permission = await Location.requestBackgroundPermissionsAsync();
      }

      if (permission.status !== "granted") {
        setBackgroundTrackingStatus("denied");
        return false;
      }

      const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK,
      );
      if (!alreadyStarted) {
        await Location.startLocationUpdatesAsync(
          BACKGROUND_LOCATION_TASK,
          BACKGROUND_GPS_OPTIONS,
        );
      }

      setBackgroundTrackingStatus("active");
      return true;
    } catch (error) {
      console.warn("No se pudo activar el GPS en segundo plano:", error);
      setBackgroundTrackingStatus("unavailable");
      return false;
    }
  }, []);

  useEffect(() => {
    if (!isTracking) return;

    void importStoredRoutePoints();
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void importStoredRoutePoints();
      }
    });

    return () => appStateSubscription.remove();
  }, [importStoredRoutePoints, isTracking]);

  const startTracking = useCallback(async () => {
    if (subscriptionRef.current || isTracking) return;
    if (!myPlayerId) {
      setErrorMsg("El perfil local del jugador aun se esta preparando.");
      return;
    }

    if (passiveSubscriptionRef.current) {
      passiveSubscriptionRef.current.remove();
      passiveSubscriptionRef.current = null;
    }

    try {
      if (!IS_EXPO_GO) {
        const oldTaskStarted = await Location.hasStartedLocationUpdatesAsync(
          BACKGROUND_LOCATION_TASK,
        );
        if (oldTaskStarted) {
          await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
        }
      }

      const resumesSavedRoute =
        hasPendingSavedRoute && rawTrackRef.current.length >= 2;

      if (resumesSavedRoute) {
        await markStoredRouteActive();
        setHasPendingSavedRoute(false);
        debugLog("GPS", "Continuando el recorrido guardado sin perder puntos.");
      } else {
        await clearStoredRouteSession();
        const startedAt = Date.now();
        await beginStoredRouteSession(
          myPlayerId,
          startedAt,
          !isOnlineRef.current,
        );

        trackingGenerationRef.current += 1;
        if (roadMatchTimerRef.current) {
          clearTimeout(roadMatchTimerRef.current);
          roadMatchTimerRef.current = null;
        }
        roadMatchQueuedRef.current = false;
        lastMatchedRawCountRef.current = 0;
        lastRoadMatchAtRef.current = 0;
        lastAnalyzedSegmentRef.current = 1;
        rawTrackRef.current = [];
        roadSegmentsRef.current = [];
        sessionStartedAtRef.current = startedAt;
        sessionTerritoryCountRef.current = 0;
        sessionAreaM2Ref.current = 0;
        setSensorEvidence(null);
        setRouteCoords([]);
        setRawPointCount(0);
        setRoadSegmentCount(0);
        setIntersectionCount(0);
        setRoadMatchStatus("waiting");
        lastAcceptedCoordinateRef.current = null;
        routeCoordsRef.current = [];
        mapRef.current?.injectJavaScript("window.clearRoute?.(); true;");

        if (location) {
          const initialPoint: StoredLocationPoint = {
            latitude: location.latitude,
            longitude: location.longitude,
            accuracy: gpsAccuracy,
            timestamp: location.timestamp ?? Date.now(),
          };
          processRoutePoint(initialPoint);
        }
      }

      setIsTracking(true);

      void motionSensorTrackerRef.current.start(setSensorEvidence).then((availability) => {
        const activeSensorCount = Object.values(availability).filter(
          Boolean,
        ).length;
        debugLog(
          "GPS",
          activeSensorCount > 0
            ? `Apoyo de sensores activo (${activeSensorCount} fuentes).`
            : "Sensores no disponibles; continua GPS + Map Matching.",
        );
      });

      const subscription = await Location.watchPositionAsync(
        REAL_TIME_GPS_OPTIONS,
        (newLocation) => {
          processRoutePoint({
            latitude: newLocation.coords.latitude,
            longitude: newLocation.coords.longitude,
            accuracy: newLocation.coords.accuracy,
            heading: newLocation.coords.heading,
            speed: newLocation.coords.speed,
            timestamp: newLocation.timestamp,
          }, true, motionSensorTrackerRef.current.getEvidence());
        },
      );

      subscriptionRef.current = subscription;
      void enableBackgroundTracking();
    } catch (error) {
      motionSensorTrackerRef.current.stopSession();
      console.warn("Error al iniciar el seguimiento GPS:", error);
      setErrorMsg("Error al iniciar el seguimiento GPS.");
      setIsTracking(false);
    }
  }, [
    enableBackgroundTracking,
    gpsAccuracy,
    hasPendingSavedRoute,
    isTracking,
    location,
    myPlayerId,
    processRoutePoint,
  ]);

  // ─── Detener recorrido ───────────────────────────────────────
  const stopTracking = useCallback(async () => {
    const sensorMetrics = motionSensorTrackerRef.current.stopSession();
    const endedAt = Date.now();
    if (subscriptionRef.current) {
      subscriptionRef.current.remove();
      subscriptionRef.current = null;
    }

    try {
      if (!IS_EXPO_GO) {
        const taskStarted = await Location.hasStartedLocationUpdatesAsync(
          BACKGROUND_LOCATION_TASK,
        );
        if (taskStarted) {
          await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
        }
        await importStoredRoutePoints();
        setBackgroundTrackingStatus("inactive");
      }
      if (roadMatchTimerRef.current) {
        clearTimeout(roadMatchTimerRef.current);
        roadMatchTimerRef.current = null;
      }
      const finalBatchMatched = await runRoadMatchRef.current(true);
      const allPointsMatched =
        finalBatchMatched &&
        lastMatchedRawCountRef.current >= rawTrackRef.current.length;
      if (allPointsMatched) {
        await clearStoredRouteSession();
        setHasPendingSavedRoute(false);
      } else if (rawTrackRef.current.length >= 2) {
        const storedSession = await getStoredRouteSession();
        const provisional = detectProvisionalOfflineCandidate(rawTrackRef.current);
        await markStoredRoutePending(endedAt);
        if (storedSession) {
          await savePendingTerritory({
            id: `pending-${storedSession.id}`,
            sessionId: storedSession.id,
            rawTrack: rawTrackRef.current,
            sensorEvidence,
            candidatePolygon: provisional?.polygon ?? null,
            createdOffline: !isOnlineRef.current,
            status: "pending_validation",
            reason: provisional
              ? "Cierre provisional pendiente de validar contra la red vial."
              : "Recorrido pendiente de ajustar a la red vial.",
            createdAt: endedAt,
          });
        }
        setHasPendingSavedRoute(true);
      } else {
        await clearStoredRouteSession();
        setHasPendingSavedRoute(false);
      }

      const summary = createTrackingSessionSummary({
        rawTrack: rawTrackRef.current,
        metrics: sensorMetrics,
        startedAt: sessionStartedAtRef.current || endedAt,
        endedAt,
        territoriesCaptured: sessionTerritoryCountRef.current,
        areaCapturedM2: sessionAreaM2Ref.current,
        dailySteps: sensorMetrics.dailySteps ?? 0,
      });
      const completedSummary = await saveTrackingSession(summary);
      setLatestSession(completedSummary);
    } catch (error) {
      console.warn("No se pudo detener el GPS en segundo plano:", error);
    } finally {
      setIsTracking(false);
    }
  }, [importStoredRoutePoints, sensorEvidence]);

  useEffect(() => {
    if (mapStatus !== "ready") return;
    mapRef.current?.injectJavaScript(
      `window.setRoute(${JSON.stringify(routeCoords)}); true;`,
    );
  }, [mapStatus, routeCoords]);

  useEffect(() => {
    if (mapStatus !== "ready") return;
    mapRef.current?.injectJavaScript(
      `window.setTerritories(${JSON.stringify(territories)}); true;`,
    );
  }, [mapStatus, territories]);

  useEffect(() => {
    if (mapStatus !== "ready") return;
    mapRef.current?.injectJavaScript(
      `window.setPlayerColor(${JSON.stringify(playerProfile.color)}); true;`,
    );
  }, [mapStatus, playerProfile.color]);

  const handleShieldUpdated = useCallback(
    (territoryId: string, shield: Territory["shield"]) => {
      setTerritories((current) => {
        const next = current.map((territory) =>
          territory.id === territoryId ? { ...territory, shield } : territory,
        );
        const updated = next.find((territory) => territory.id === territoryId);
        if (updated) {
          void updateStoredTerritory(updated).catch((error) =>
            console.warn("No se pudo guardar el estado del escudo:", error),
          );
        }
        return next;
      });
    },
    [],
  );

  useEffect(
    () => subscribeToStoredTerritories((next) => setTerritories(next)),
    [],
  );

  const lightTheme = resolvedTheme === "light";
  const panelTextColor = lightTheme ? "#172033" : "#FFFFFF";
  const secondaryTextColor = lightTheme ? "#4B5875" : "#C5CAE9";

  // ─── Pantalla principal ──────────────────────────────────────
  return (
    <View style={styles.container}>
      {/* Mapa */}
      <WebView
        ref={mapRef}
        style={styles.map}
        originWhitelist={["*"]}
        source={{ html: MAP_HTML }}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        onLoadStart={() => setMapStatus("loading")}
        onError={({ nativeEvent }) => {
          console.warn("No se pudo cargar el WebView del mapa:", nativeEvent.description);
          setMapStatus("error");
        }}
        onHttpError={({ nativeEvent }) => {
          console.warn(
            "Error HTTP dentro del mapa:",
            nativeEvent.statusCode,
            nativeEvent.url,
          );
          setMapStatus("error");
        }}
        onMessage={({ nativeEvent }) => {
          try {
            const message = JSON.parse(nativeEvent.data) as {
              type?: string;
              detail?: string;
            };
            if (message.type === "map-ready") setMapStatus("ready");
            if (message.type === "map-error") {
              console.warn("Error del mapa:", message.detail ?? "desconocido");
              setMapStatus("error");
            }
          } catch {
            setMapStatus("error");
          }
        }}
        onLoadEnd={() => {
          if (location) {
            mapRef.current?.injectJavaScript(
              `window.setUserLocation(${location.latitude}, ${location.longitude}, true); true;`,
            );
          }
        }}
      />

      {isLoading && (
        <View pointerEvents="none" style={styles.loadingBadge}>
          <ActivityIndicator size="small" color={TRAIL_COLOR} />
          <Text style={styles.loadingBadgeText}>Buscando ubicacion...</Text>
        </View>
      )}

      {!isOnline && (
        <View pointerEvents="none" style={styles.offlineBadge}>
          <Text style={styles.offlineTitle}>Sin conexión</Text>
          <Text style={styles.offlineText}>
            Guardando recorrido en el dispositivo
          </Text>
        </View>
      )}

      {isOnline && hasPendingSavedRoute && roadMatchStatus !== "ready" && (
        <View pointerEvents="none" style={styles.syncBadge}>
          <Text style={styles.syncText}>Validando recorrido pendiente...</Text>
        </View>
      )}

      {errorMsg && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMsg}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={retryLocationPermission}
          >
            <Text style={styles.retryButtonText}>Reintentar permiso y GPS</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={launchLocationSettings}
          >
            <Text style={styles.retryButtonText}>Abrir ajustes de GPS</Text>
          </TouchableOpacity>
        </View>
      )}

      {mapStatus === "error" && (
        <View pointerEvents="none" style={styles.mapErrorBanner}>
          <Text style={styles.mapErrorText}>
            {isOnline
              ? "No se pudo cargar el mapa. Intenta nuevamente."
              : "El mapa base no está disponible; tu recorrido sigue guardándose."}
          </Text>
        </View>
      )}

      <TerritoryShieldPanel
        territories={territories}
        playerId={myPlayerId}
        onShieldUpdated={handleShieldUpdated}
      />

      <View pointerEvents="none" style={styles.gpsBadge}>
        <View
          style={[
            styles.gpsDot,
            {
              backgroundColor:
                gpsAccuracy !== null &&
                gpsAccuracy <= MAX_ACCEPTABLE_ACCURACY_METERS
                  ? "#4CAF50"
                  : "#FFB300",
            },
          ]}
        />
        <Text style={styles.gpsBadgeText}>
          {gpsAccuracy === null
            ? "GPS esperando senal"
            : `GPS ±${Math.round(gpsAccuracy)} m${
                gpsAccuracy > MAX_ACCEPTABLE_ACCURACY_METERS
                  ? " - precision baja"
                  : ""
              }`}
        </Text>
      </View>

      {/* Panel de controles */}
      <View
        style={[
          styles.controlPanel,
          {
            backgroundColor: lightTheme
              ? "rgba(255, 255, 255, 0.95)"
              : "rgba(26, 26, 46, 0.92)",
          },
        ]}
      >
        {/* Indicador de estado */}
        <View style={styles.statusContainer}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: isTracking ? "#4CAF50" : "#9E9E9E" },
            ]}
          />
          <Text style={[styles.statusText, { color: panelTextColor }]}>
            {isTracking ? "Recorrido activo" : "Recorrido detenido"}
          </Text>
          {rawPointCount > 0 && (
            <Text style={[styles.coordCount, { color: secondaryTextColor }]}>
              {rawPointCount} GPS / {routeCoords.length} vial
            </Text>
          )}
          {territories.length > 0 && (
            <Text style={styles.territoryCount}>
              {territories.length} territorio
              {territories.length !== 1 ? "s" : ""}
            </Text>
          )}
        </View>

        <Text
          style={[styles.backgroundStatusText, { color: secondaryTextColor }]}
        >
          {BACKGROUND_STATUS_LABEL[backgroundTrackingStatus]}
        </Text>

        <View style={styles.pushStatusRow}>
          <Text
            style={[
              styles.backgroundStatusText,
              styles.roadStatusText,
              { color: secondaryTextColor },
            ]}
          >
            {ROAD_STATUS_LABEL[roadMatchStatus]}
            {roadSegmentCount > 0
              ? ` · ${roadSegmentCount} segmentos · ${intersectionCount} cruces`
              : ""}
          </Text>
          {roadMatchStatus === "error" && (
            <TouchableOpacity
              style={styles.intentButton}
              onPress={() => scheduleRoadMatch(true)}
            >
              <Text style={styles.intentButtonText}>Reintentar</Text>
            </TouchableOpacity>
          )}
        </View>

        {totalAreaM2 > 0 && (
          <Text style={styles.territoryAreaText}>
            Area total: {Math.round(totalAreaM2).toLocaleString()} m²
          </Text>
        )}

        <View style={styles.pushStatusRow}>
          <Text
            style={[styles.backgroundStatusText, { color: secondaryTextColor }]}
          >
            {PUSH_STATUS_LABEL[pushStatus]}
          </Text>
          {pushStatus === "permission-denied" && (
            <TouchableOpacity
              style={styles.intentButton}
              onPress={launchNotificationSettings}
            >
              <Text style={styles.intentButtonText}>Abrir ajustes</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Botón de inicio/detención */}
        <View style={styles.themeRow}>
          <Text style={[styles.themeLabel, { color: panelTextColor }]}>Tema</Text>
          {(["light", "dark", "auto"] as ThemePreference[]).map(
            (preference) => (
              <TouchableOpacity
                key={preference}
                style={[
                  styles.themeButton,
                  themePreference === preference && styles.themeButtonActive,
                ]}
                onPress={() => selectTheme(preference)}
              >
                <Text
                  style={[
                    styles.themeButtonText,
                    themePreference === preference &&
                      styles.themeButtonTextActive,
                  ]}
                >
                  {preference === "light"
                    ? "Claro"
                    : preference === "dark"
                      ? "Oscuro"
                      : "Auto"}
                </Text>
              </TouchableOpacity>
            ),
          )}
        </View>

        {isTracking && sensorEvidence && (
          <View style={styles.sensorSummary}>
            <Text style={[styles.sensorText, { color: secondaryTextColor }]}>
              Pasos: {sensorEvidence.sessionStepCount ?? "no disponible"}
              {sensorEvidence.dailyStepCount !== null &&
              sensorEvidence.dailyStepCount !== undefined
                ? ` · Hoy: ${sensorEvidence.dailyStepCount}`
                : ""}
              {sensorEvidence.relativeElevationMeters !== null &&
              sensorEvidence.relativeElevationMeters !== undefined
                ? ` · Altura ${sensorEvidence.relativeElevationMeters >= 0 ? "+" : ""}${sensorEvidence.relativeElevationMeters.toFixed(1)} m`
                : " · Altura no disponible"}
            </Text>
            {sensorEvidence.magneticConfidence === "low" && (
              <Text style={styles.magneticWarning}>
                Interferencia magnetica: se prioriza GPS y continuidad vial.
              </Text>
            )}
          </View>
        )}

        {!isTracking && latestSession && (
          <View style={styles.sessionSummary}>
            <Text style={[styles.sessionTitle, { color: panelTextColor }]}>
              Ultimo recorrido
            </Text>
            <Text style={[styles.sensorText, { color: secondaryTextColor }]}>
              {Math.round(latestSession.distanceMeters).toLocaleString()} m · {latestSession.steps === null ? "pasos no disponibles" : `${latestSession.steps} pasos`} · {formatDuration(latestSession.durationMs)}
            </Text>
            <Text style={[styles.sensorText, { color: secondaryTextColor }]}>
              Hoy: {latestSession.dailySteps.toLocaleString()} pasos · {latestSession.territoriesCaptured} territorios · {Math.round(latestSession.areaCapturedM2).toLocaleString()} m²
            </Text>
            <Text style={[styles.sensorText, { color: secondaryTextColor }]}>
              Desnivel aprox.: +{Math.round(latestSession.ascentMeters ?? 0)} m / -{Math.round(latestSession.descentMeters ?? 0)} m
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[
            styles.actionButton,
            isTracking ? styles.stopButton : styles.startButton,
          ]}
          onPress={isTracking ? stopTracking : startTracking}
          activeOpacity={0.8}
        >
          <Text style={styles.actionButtonText}>
            {isTracking
              ? "⏹  Detener recorrido"
              : hasPendingSavedRoute
                ? "▶  Continuar recorrido guardado"
                : "▶  Iniciar recorrido"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Estilos ─────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  attribution: {
    position: "absolute",
    left: 8,
    bottom: Platform.select({ ios: 130, android: 116 }),
    backgroundColor: "rgba(255, 255, 255, 0.82)",
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 3,
  },
  attributionText: {
    color: "#222222",
    fontSize: 10,
  },
  loadingBadge: {
    position: "absolute",
    top: 54,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(26, 26, 46, 0.92)",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  loadingBadgeText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "600",
  },
  offlineBadge: {
    position: "absolute",
    top: 96,
    alignSelf: "center",
    backgroundColor: "rgba(26, 26, 46, 0.94)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignItems: "center",
  },
  offlineTitle: {
    color: "#FFCC80",
    fontSize: 13,
    fontWeight: "800",
  },
  offlineText: {
    color: "#FFFFFF",
    fontSize: 11,
    marginTop: 2,
  },
  syncBadge: {
    position: "absolute",
    top: 96,
    alignSelf: "center",
    backgroundColor: "rgba(26, 26, 46, 0.94)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  syncText: {
    color: "#80CBC4",
    fontSize: 12,
    fontWeight: "700",
  },
  errorBanner: {
    position: "absolute",
    top: 54,
    left: 16,
    right: 16,
    backgroundColor: "rgba(120, 20, 20, 0.94)",
    borderRadius: 12,
    padding: 12,
  },
  retryButton: {
    alignSelf: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  retryButtonText: {
    color: "#7A1414",
    fontSize: 13,
    fontWeight: "700",
  },
  mapErrorBanner: {
    position: "absolute",
    top: 116,
    left: 16,
    right: 16,
    backgroundColor: "rgba(120, 72, 10, 0.94)",
    borderRadius: 12,
    padding: 12,
  },
  mapErrorText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
  gpsBadge: {
    position: "absolute",
    top: 54,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(26, 26, 46, 0.92)",
    borderRadius: 16,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  gpsDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  gpsBadgeText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "600",
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#1A1A2E",
    padding: 32,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: "#E0E0E0",
    fontWeight: "500",
  },
  errorIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  errorText: {
    fontSize: 16,
    color: "#E0E0E0",
    textAlign: "center",
    lineHeight: 24,
  },
  controlPanel: {
    position: "absolute",
    bottom: Platform.select({ ios: 40, android: 24 }),
    left: 16,
    right: 16,
    backgroundColor: "rgba(26, 26, 46, 0.92)",
    borderRadius: 20,
    padding: 20,
    gap: 16,
    // Sombra
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  statusContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#FFFFFF",
    flex: 1,
  },
  coordCount: {
    fontSize: 13,
    color: "#9E9E9E",
  },
  territoryCount: {
    fontSize: 13,
    color: "#B39DDB",
  },
  territoryAreaText: {
    color: "#80CBC4",
    fontSize: 13,
    fontWeight: "700",
  },
  backgroundStatusText: {
    color: "#C5CAE9",
    fontSize: 12,
  },
  roadStatusText: {
    flex: 1,
    paddingRight: 8,
  },
  pushStatusRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  intentButton: {
    backgroundColor: "#3949AB",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  intentButtonText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
  },
  themeRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
  },
  themeLabel: {
    flex: 1,
    fontSize: 12,
    fontWeight: "700",
  },
  themeButton: {
    backgroundColor: "#E3E7EF",
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  themeButtonActive: {
    backgroundColor: "#3949AB",
  },
  themeButtonText: {
    color: "#384152",
    fontSize: 11,
    fontWeight: "700",
  },
  themeButtonTextActive: {
    color: "#FFFFFF",
  },
  sensorSummary: {
    gap: 4,
  },
  sensorText: {
    fontSize: 12,
    lineHeight: 17,
  },
  magneticWarning: {
    color: "#FF9800",
    fontSize: 12,
    fontWeight: "700",
  },
  sessionSummary: {
    gap: 2,
  },
  sessionTitle: {
    fontSize: 12,
    fontWeight: "800",
  },
  actionButton: {
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  startButton: {
    backgroundColor: "#4CAF50",
  },
  stopButton: {
    backgroundColor: "#FF4444",
  },
  actionButtonText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#FFFFFF",
    letterSpacing: 0.5,
  },
});
