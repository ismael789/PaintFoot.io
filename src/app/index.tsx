import { Palette } from "@/constants/palette";
import Constants from "expo-constants";
import NetInfo from "@react-native-community/netinfo";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  markStoredRouteConnectionState,
  markStoredRoutePending,
  type StoredLocationPoint,
} from "@/services/background-location";
import {
  openLocationSettingsIntent,
  openNotificationSettingsIntent,
} from "@/services/android-intents";
import {
  registerForRemotePushNotifications,
  sendLocalGameNotification,
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
  coordinateRegionId,
  getPendingTerritories,
  getRoadSegmentsNearTrack,
  getRecoverableTrackingSession,
  getTrackingSessionById,
  isActiveOfflineSessionStatus,
  resolvePendingTerritory,
  saveRoadSegmentsToCache,
  savePendingTerritory,
  saveTrustedServerTime,
  setActiveTrackingCacheCoverage,
  verifySessionHashChain,
} from "@/services/offline-storage";
import {
  getOfflineSyncSnapshot,
  publishOfflineSyncStatus,
  synchronizePendingOperations,
} from "@/services/offline-sync";
import { showFeedback } from "@/services/global-feedback";
import { detectProvisionalOfflineCandidate } from "@/services/offline-validation";
import { MotionSensorTracker } from "@/services/motion-sensors";
import { AmbientThemeController } from "@/services/sensor-metrics";
import { sensorCapabilityManager } from "@/services/sensor-capabilities";
import { buildEndpointCandidates } from "@/services/network-endpoints";
import {
  createTrackingSessionSummary,
  shouldAcceptRoadTransition,
} from "@/services/sensor-fusion";
import { shouldAcceptStableGpsUpdate } from "@/services/location-stability";
import {
  getLatestTrackingSession,
  getThemePreference,
  saveThemePreference,
  saveTrackingSession,
} from "@/services/tracking-stats";
import {
  DEFAULT_PLAYER_PROFILE,
  applyAccountPlayerIdentity,
  getActivePlayerId,
  getOrCreatePlayerProfile,
} from "@/services/player-profile";
import {
  collectCoin,
  filterUncollectedCoins,
  getCoinBalance,
  getStoredWorldCoinCatalogNear,
  saveWorldCoinCatalog,
  type MapCoin,
} from "@/services/coins";
import { getPersistedAuthSession } from "@/services/auth";
import {
  createTerritoryFromLoop,
  detectClosedLoops,
} from "@/services/territory-detection";
import {
  appendStoredTerritories,
  discardStoredPendingCapture,
  getStoredTerritories,
  subscribeToStoredTerritories,
  updateStoredTerritory,
  resolveStoredGlobalCapture,
  restoreStoredTerritoriesFromBackup,
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

function contrastingMapColor(color: string) {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return Palette.danger;
  const value = Number.parseInt(match[1], 16);
  const red = 255 - ((value >> 16) & 0xff);
  const green = 255 - ((value >> 8) & 0xff);
  const blue = 255 - (value & 0xff);
  return `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

import { debugLog } from "@/utils/debug-log";
import { distanceInMeters } from "@/utils/geo";
import { MAP_HTML } from "@/services/map-html";
import {
  fetchRoadNetworkForBounds,
  getBundledSanLuisRioColoradoRoadSegmentsNear,
  isInsideSanLuisRioColoradoUrbanArea,
  prefetchRoadRegionsNear,
} from "@/services/regional-road-cache";
import {
  COIN_ACTIVE_MEMORY_LIMIT,
  COIN_LOAD_RADIUS_METERS,
  COIN_UNLOAD_RADIUS_METERS,
  createRegionalStreetCoins,
  WORLD_COIN_MINIMUM_NEARBY_VISIBLE,
  WORLD_COIN_NEARBY_REFRESH_CELL_DEGREES,
} from "@/services/world-coins";
import {
  confirmGlobalTerritoryCapture,
  GlobalMultiplayerController,
  synchronizeGlobalPlayerProfile,
  synchronizeGlobalTerritoryShield,
  type GlobalWorldStatus,
} from "@/services/global-multiplayer";
import {
  DEFAULT_MULTIPLAYER_PREFERENCES,
  getMultiplayerPreferences,
  type MultiplayerPreferences,
} from "@/services/multiplayer-preferences";
import {
  publishGameSystemStatus,
  registerGameSystemActions,
  type BackgroundTrackingStatus,
  type PushStatus,
  type RoadMatchStatus,
} from "@/services/game-system-status";

// ─── Trail Config ────────────────────────────────────────────────
const TRAIL_COLOR = Palette.danger;
const TRAIL_STROKE_WIDTH = 5;
const IS_EXPO_GO = Constants.expoGoConfig !== null;
const DEBUG_COINS = __DEV__ || process.env.EXPO_PUBLIC_DEBUG_COINS === "true";

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

function getWebSocketUrls() {
  return buildEndpointCandidates(
    process.env.EXPO_PUBLIC_WS_URL,
    Constants.expoConfig?.hostUri,
    { scheme: "ws", defaultPort: 8082 },
  );
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
  const insets = useSafeAreaInsets();
  const { territoryId: requestedTerritoryId } = useLocalSearchParams<{
    territoryId?: string;
  }>();
  const { height, fontScale } = useWindowDimensions();
  const compactLayout = height < 700 || fontScale > 1.15;
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
  const [roadsUsingCache, setRoadsUsingCache] = useState(false);
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
  const [multiplayerPreferences, setMultiplayerPreferences] =
    useState<MultiplayerPreferences>(DEFAULT_MULTIPLAYER_PREFERENCES);
  const [coinBalance, setCoinBalance] = useState(0);
  const [activeCoins, setActiveCoins] = useState<MapCoin[]>([]);
  const [coinViewportCenter, setCoinViewportCenter] =
    useState<Coordinate | null>(null);
  const [worldStatus, setWorldStatus] =
    useState<GlobalWorldStatus>("local");
  const myPlayerId = getActivePlayerId(playerProfile);

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
  const multiplayerPreferencesRef = useRef(multiplayerPreferences);
  const globalMultiplayerRef = useRef<GlobalMultiplayerController | null>(null);
  const globalTerritoriesLoadedRef = useRef(false);
  const nearbyPlayerCountRef = useRef(0);
  const activeCoinsRef = useRef<MapCoin[]>([]);
  const coinFallbackRegionRef = useRef<string | null>(null);
  const coinViewportCenterRef = useRef<Coordinate | null>(null);
  const mapPerspectiveRef = useRef({
    playerId: myPlayerId,
    playerColor: playerProfile.color,
  });

  useEffect(() => {
    isTrackingRef.current = isTracking;
  }, [isTracking]);

  useEffect(() => {
    mapPerspectiveRef.current = {
      playerId: myPlayerId,
      playerColor: playerProfile.color,
    };
  }, [myPlayerId, playerProfile.color]);

  useEffect(() => {
    if (mapStatus !== "ready") return;
    mapRef.current?.injectJavaScript(
      `window.setCoins?.(${JSON.stringify(activeCoins)}); true;`,
    );
  }, [activeCoins, mapStatus]);

  // Las monedas cercanas pertenecen a la ubicacion real del jugador. El centro
  // del viewport solo sirve como respaldo antes de recibir la primera lectura
  // GPS y nunca debe cambiar el catalogo personal al desplazar el mapa.
  const effectiveCoinCenter = location ?? coinViewportCenter;
  const currentCoinRegionId = effectiveCoinCenter
    ? coordinateRegionId(effectiveCoinCenter)
    : null;
  const currentCoinProximityId = effectiveCoinCenter
    ? `${Math.floor((effectiveCoinCenter.latitude + 90) / WORLD_COIN_NEARBY_REFRESH_CELL_DEGREES)}_${Math.floor((effectiveCoinCenter.longitude + 180) / WORLD_COIN_NEARBY_REFRESH_CELL_DEGREES)}`
    : null;

  useEffect(() => {
    if (!location || !currentCoinProximityId) return;
    const hasNearbyCoins = activeCoins.some(
      (coin) =>
        (!coin.availableAt || Date.now() >= coin.availableAt) &&
        distanceInMeters(location, coin) <= 120,
    );
    if (!hasNearbyCoins) return;
    void sendLocalGameNotification({
      category: "coins",
      eventKey: `coins_nearby:${currentCoinProximityId}`,
      title: "Monedas cercanas",
      body: "Hay monedas disponibles cerca de ti.",
      url: "paintfoot://coins",
      cooldownMs: 30 * 60_000,
    });
  }, [activeCoins, currentCoinProximityId, location]);

  useEffect(() => {
    if (!location || !effectiveCoinCenter || !currentCoinRegionId) return;
    let cancelled = false;
    const centers = [effectiveCoinCenter];
    if (distanceInMeters(location, effectiveCoinCenter) > COIN_LOAD_RADIUS_METERS / 2) {
      centers.push(location);
    }
    const distanceToLoadedArea = (coin: MapCoin) =>
      Math.min(...centers.map((center) => distanceInMeters(coin, center)));
    const showCatalog = async (catalog: MapCoin[], label: string) => {
      const localCatalog = catalog
        .filter((coin) => distanceToLoadedArea(coin) <= COIN_UNLOAD_RADIUS_METERS)
        .sort((first, second) =>
          distanceToLoadedArea(first) - distanceToLoadedArea(second) ||
          first.id.localeCompare(second.id),
        )
        .slice(0, COIN_ACTIVE_MEMORY_LIMIT);
      const availableCoins = await filterUncollectedCoins(localCatalog);
      if (cancelled) return availableCoins;
      activeCoinsRef.current = availableCoins;
      setActiveCoins(availableCoins);
      if (DEBUG_COINS) {
        console.info(
          `[Coins] region actual: ${currentCoinRegionId} · ${label}: ${availableCoins.length}`,
        );
      }
      return availableCoins;
    };
    const loadRoadSegments = async (center: Coordinate) => {
      const bundledSegments = isInsideSanLuisRioColoradoUrbanArea(center)
        ? getBundledSanLuisRioColoradoRoadSegmentsNear(
            center,
            COIN_UNLOAD_RADIUS_METERS,
          )
        : [];
      const cached = await getRoadSegmentsNearTrack(
        [center],
        COIN_UNLOAD_RADIUS_METERS / 111_320,
      );
      let segments = [...new Map(
        [...bundledSegments, ...cached].map((segment) => [segment.id, segment]),
      ).values()];
      if (segments.length > 0 || !isOnlineRef.current) return segments;
      try {
        await prefetchRoadRegionsNear(center);
        segments = await getRoadSegmentsNearTrack(
          [center],
          COIN_UNLOAD_RADIUS_METERS / 111_320,
        );
      } catch {
        debugLog("ROAD", "La cache vial cercana se completara en segundo plano.");
      }
      if (segments.length > 0) return segments;
      try {
        const latitudePadding = COIN_LOAD_RADIUS_METERS / 111_320;
        const longitudePadding = latitudePadding /
          Math.max(0.2, Math.cos((center.latitude * Math.PI) / 180));
        segments = await fetchRoadNetworkForBounds({
          south: center.latitude - latitudePadding,
          west: center.longitude - longitudePadding,
          north: center.latitude + latitudePadding,
          east: center.longitude + longitudePadding,
        });
        if (segments.length > 0) {
          await saveRoadSegmentsToCache(segments, {
            coverageStatus: "partial",
            priority: 80,
          });
        }
      } catch {
        debugLog("ROAD", "Se usaran las calles guardadas cuando esten disponibles.");
      }
      return segments;
    };
    const loadStreetCoins = async () => {
      const storedCatalog = await getStoredWorldCoinCatalogNear(centers).catch(() => []);
      if (storedCatalog.length > 0) await showCatalog(storedCatalog, "guardadas");

      const segmentGroups = await Promise.all(centers.map(loadRoadSegments));
      const segments = [...new Map(
        segmentGroups.flat().map((segment) => [segment.id, segment]),
      ).values()];
      if (cancelled) return;
      roadSegmentsRef.current = segments;
      const generated = centers.flatMap((center) =>
        createRegionalStreetCoins(center, segments),
      );
      // Las densidades anteriores siguen persistidas para no perder estados;
      // cuando existe geometria local se dibuja solo v6 y se evitan traslapes.
      const regionalCatalog = generated.length > 0 ? generated : storedCatalog;
      if (generated.length > 0) {
        void saveWorldCoinCatalog(generated, myPlayerId).catch(() => undefined);
      }
      await showCatalog(regionalCatalog, "vias regionales");
      if (DEBUG_COINS) {
        console.info(`[Coins] vias cargadas: ${segments.length}`);
      }
    };
    void loadStreetCoins().catch((error) => {
      if (DEBUG_COINS) console.info(`[Coins] carga diferida: ${String(error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [currentCoinProximityId, currentCoinRegionId, myPlayerId]);

  useEffect(() => {
    multiplayerPreferencesRef.current = multiplayerPreferences;
  }, [multiplayerPreferences]);

  useEffect(() => {
    const sensorStates = sensorCapabilityManager.getSnapshot();
    publishGameSystemStatus({
      backgroundTracking: backgroundTrackingStatus,
      push: pushStatus,
      world: worldStatus,
      roads: roadMatchStatus,
      roadsUsingCache,
      gpsAccuracy,
      gpsAvailable: hasLocationPermission,
      sensorsAvailable: sensorStates.filter((sensor) => sensor.available).length,
      sensorsActive: sensorStates.filter((sensor) => sensor.active).length,
      sensorsTotal: sensorStates.length,
      online: isOnline,
      pendingValidation: hasPendingSavedRoute || roadMatchStatus === "pending",
    });
  }, [
    backgroundTrackingStatus,
    gpsAccuracy,
    hasLocationPermission,
    hasPendingSavedRoute,
    isOnline,
    pushStatus,
    roadMatchStatus,
    roadsUsingCache,
    sensorEvidence,
    worldStatus,
  ]);

  useEffect(() => {
    const controller = new GlobalMultiplayerController({
      onTerritories: (globalTerritories) => {
        void restoreStoredTerritoriesFromBackup(globalTerritories);
        setTerritories((current) => {
          if (globalTerritoriesLoadedRef.current) {
            let gameEvent: { message: string; type: "success" | "warning" | "info" } | null = null;
            let changedTerritoryId: string | null = null;
            for (const territory of globalTerritories) {
              const previous = current.find(
                (item) =>
                  item.id === territory.id || item.signature === territory.signature,
              );
              if (previous && previous.playerId !== territory.playerId) {
                gameEvent = {
                  message:
                    previous.playerId === myPlayerId
                      ? "Territorio robado por otro jugador"
                      : territory.playerId === myPlayerId
                        ? "Territorio robado"
                        : "Territorio actualizado",
                  type: previous.playerId === myPlayerId ? "warning" : "success",
                };
                changedTerritoryId = territory.id;
                break;
              }
              if (
                previous &&
                previous.status !== "protected" &&
                territory.status === "protected"
              ) {
                gameEvent = { message: "Territorio protegido", type: "warning" };
                changedTerritoryId = territory.id;
              } else if (!previous && !gameEvent) {
                gameEvent = { message: "Territorio conquistado", type: "success" };
                changedTerritoryId = territory.id;
              }
            }
            if (gameEvent) {
              showFeedback({
                id: "multiplayer-territory",
                type: gameEvent.type,
                message: gameEvent.message,
              });
              const stolen = gameEvent.message === "Territorio robado por otro jugador";
              void sendLocalGameNotification({
                category: "world",
                eventKey: `world_territory:${changedTerritoryId ?? "nearby"}:${gameEvent.message}`,
                title: stolen ? "Territorio robado" : gameEvent.message,
                body: stolen
                  ? "Otro jugador capturó uno de tus territorios."
                  : "El mundo global de PaintFoot.io fue actualizado.",
                url: changedTerritoryId
                  ? `paintfoot://territory/${changedTerritoryId}`
                  : "paintfoot://map",
                territoryId: changedTerritoryId ?? undefined,
                cooldownMs: 60_000,
              });
            }
          }
          globalTerritoriesLoadedRef.current = true;
          const bySignature = new Map(
            current.map((territory) => [territory.signature, territory]),
          );
          for (const territory of globalTerritories) {
            bySignature.set(territory.signature, territory);
          }
          return [...bySignature.values()];
        });
      },
      onNearbyPlayers: (players) => {
        if (players.length !== nearbyPlayerCountRef.current) {
          nearbyPlayerCountRef.current = players.length;
          if (players.length > 0) {
            showFeedback({
              id: "nearby-players",
              type: "info",
              message: "Jugadores cercanos actualizados",
              cooldownMs: 30_000,
            });
          }
        }
        const visiblePlayers = players.map((player) => ({
          ...player,
          color:
            player.id === mapPerspectiveRef.current.playerId
              ? mapPerspectiveRef.current.playerColor
              : contrastingMapColor(mapPerspectiveRef.current.playerColor),
          name: multiplayerPreferencesRef.current.showPlayerNames
            ? player.name
            : "",
        }));
        mapRef.current?.injectJavaScript(
          `window.setOtherPlayers(${JSON.stringify(visiblePlayers)}); true;`,
        );
      },
      onStatus: (status) => {
        setWorldStatus(status);
        if (status === "active") {
          showFeedback({
            id: "world-status",
            type: "success",
            message: "Mundo global activo",
            cooldownMs: 30_000,
          });
        } else if (status === "connecting") {
          showFeedback({
            id: "world-status",
            type: "info",
            message: "Reconectando al mundo global",
          });
        } else if (status === "offline" && !isOnlineRef.current) {
          showFeedback({
            id: "world-status",
            type: "info",
            message: "Sin conexión · mundo global pausado",
          });
        }
      },
    });
    globalMultiplayerRef.current = controller;
    return () => {
      globalMultiplayerRef.current = null;
      void controller.stop();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected =
        state.isConnected !== false && state.isInternetReachable !== false;
      const wasOnline = isOnlineRef.current;
      isOnlineRef.current = connected;
      setIsOnline(connected);
      if (isTrackingRef.current) {
        void markStoredRouteConnectionState(
          connected
            ? wasOnline
              ? "active_local"
              : "active_syncing"
            : "active_offline",
        );
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getThemePreference(),
      getLatestTrackingSession(),
      getMultiplayerPreferences(),
    ]).then(
      ([preference, summary, globalPreferences]) => {
        if (cancelled) return;
        setThemePreference(preference);
        if (preference !== "auto") setResolvedTheme(preference);
        setLatestSession(summary);
        setMultiplayerPreferences(globalPreferences);
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
    void Promise.all([
      getPersistedAuthSession().then(async (session) => {
        const profile = await getOrCreatePlayerProfile();
        return session?.user.name
          ? applyAccountPlayerIdentity({
              id: session.user.id,
              name: session.user.name,
            })
          : profile;
      }).then(synchronizeGlobalPlayerProfile),
      getMultiplayerPreferences(),
      getThemePreference(),
      getCoinBalance(),
    ]).then(([profile, preferences, preference, balance]) => {
        if (!cancelled) {
          setPlayerProfile(profile);
          setMultiplayerPreferences(preferences);
          setThemePreference(preference);
          setCoinBalance(balance);
          if (preference !== "auto") setResolvedTheme(preference);
        }
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
    // Supabase Realtime es la autoridad del mundo global. El WebSocket local
    // queda unicamente como compatibilidad para perfiles sin sesion global.
    if (!myPlayerId || !territoriesLoaded || playerProfile.globalId) return;

    let ws: WebSocket | null = null;
    let cancelled = false;
    let attemptTimeout: ReturnType<typeof setTimeout> | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    const wsUrls = getWebSocketUrls();

    const connectToCandidate = (candidateIndex: number) => {
      if (cancelled || candidateIndex >= wsUrls.length) {
        if (!cancelled) {
          console.log(
            "[WS] No se encontro un servidor PaintFoot disponible. Modo individual activo.",
          );
        }
        return;
      }

      const wsUrl = wsUrls[candidateIndex];
      let confirmedPaintFootServer = false;
      let movedToNextCandidate = false;

      const tryNextCandidate = () => {
        if (cancelled || confirmedPaintFootServer || movedToNextCandidate) return;
        movedToNextCandidate = true;
        if (attemptTimeout) clearTimeout(attemptTimeout);
        try {
          ws?.close();
        } catch {
          // Continuar con el siguiente puerto aunque el socket anterior falle.
        }
        retryTimeout = setTimeout(
          () => connectToCandidate(candidateIndex + 1),
          100,
        );
      };

      try {
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        attemptTimeout = setTimeout(tryNextCandidate, 2_500);

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (
              !movedToNextCandidate &&
              data.type === "server-ready" &&
              data.service === "paintfoot"
            ) {
              confirmedPaintFootServer = true;
              if (attemptTimeout) clearTimeout(attemptTimeout);
              console.log("Conectado al servidor WebSocket local:", wsUrl);
              ws?.send(JSON.stringify({ type: "player-hello", id: myPlayerId }));
              if (
                latestLocationRef.current &&
                multiplayerPreferencesRef.current.shareRealtimeLocation
              ) {
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
              return;
            }

            if (
              confirmedPaintFootServer &&
              data.type === "location" &&
              data.id !== myPlayerId
            ) {
              mapRef.current?.injectJavaScript(
                `window.setOtherPlayerLocation('${data.id}', ${data.latitude}, ${data.longitude}, '${data.color || Palette.warning}'); true;`,
              );
            }
          } catch (error) {
            if (confirmedPaintFootServer) {
              console.warn("Error parseando mensaje WS:", error);
            }
          }
        };
        ws.onerror = tryNextCandidate;
        ws.onclose = () => {
          if (!confirmedPaintFootServer) tryNextCandidate();
        };
      } catch {
        tryNextCandidate();
      }
    };

    if (wsUrls.length > 0) {
      connectToCandidate(0);
    } else {
      console.warn(
        "No se configuro EXPO_PUBLIC_WS_URL y no se pudo determinar la IP local.",
      );
    }

    return () => {
      cancelled = true;
      if (attemptTimeout) clearTimeout(attemptTimeout);
      if (retryTimeout) clearTimeout(retryTimeout);
      if (ws) {
        ws.close();
      }
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [myPlayerId, playerProfile.color, playerProfile.globalId, territoriesLoaded]);

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
        showFeedback({
          id: "location-permission",
          type: "error",
          message: "Permiso de ubicación requerido",
        });
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
      showFeedback({
        id: "location-ready",
        type: "success",
        message: "Ubicación activada",
        cooldownMs: 60_000,
      });
      if (multiplayerPreferences.shareRealtimeLocation) {
        sendPlayerLocation(
          wsRef.current,
          myPlayerId,
          coords,
          playerProfile.color,
        );
      }
      mapRef.current?.injectJavaScript(
        `window.setUserLocation(${coords.latitude}, ${coords.longitude}, true); true;`,
      );
    } catch {
      setErrorMsg(
        "No se pudo obtener la ubicacion. Verifica que el GPS este activado.",
      );
      showFeedback({
        id: "location-unavailable",
        type: "error",
        message: "No se pudo obtener ubicación",
      });
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

            if (
              !shouldAcceptStableGpsUpdate(latestLocationRef.current, newCoord, {
                accuracyMeters: reportedAccuracy,
                reportedSpeedMps: newLocation.coords.speed,
                tracking: false,
                baseDistanceMeters: MINIMUM_POINT_DISTANCE_METERS,
                maximumSpeedMps: MAX_ACCEPTABLE_SPEED_MPS,
              })
            ) {
              return;
            }

            latestLocationRef.current = newCoord;
            setLocation(newCoord);
            if (multiplayerPreferencesRef.current.shareRealtimeLocation) {
              sendPlayerLocation(
                wsRef.current,
                myPlayerId,
                newCoord,
                playerProfile.color,
              );
            }
            mapRef.current?.injectJavaScript(
              `window.setUserLocation(${newCoord.latitude}, ${newCoord.longitude}, false); true;`,
            );
          },
          (reason) => {
            if (!cancelled) {
              console.warn("Seguimiento GPS no disponible:", reason);
              setErrorMsg("No se pudo continuar la ubicación en tiempo real.");
              showFeedback({
                id: "gps-tracking-error",
                type: "error",
                message: "No se pudo obtener ubicación",
              });
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
          ) && existing.status !== "protected";
          if (!conquerable) {
            debugLog("TERRITORY", "Conquista bloqueada: territorio con escudo activo.");
            showFeedback({
              id: "territory-protected",
              type: "warning",
              message: "Territorio protegido",
            });
          }
          return conquerable;
        })
        .map<Territory>((loop, index) => {
          const existing = territoriesRef.current.find(
            (territory) => territory.signature === loop.signature,
          );
          const territory = createTerritoryFromLoop(
            loop,
            playerProfile,
            createdAt + index,
            index,
          );
          const isPendingSteal = Boolean(
            existing && existing.playerId !== myPlayerId,
          );
          return {
            ...territory,
            status: !playerProfile.globalId
              ? "confirmed"
              : !isOnlineRef.current && !isPendingSteal
                ? "pending_global_sync"
                : "pending_capture",
            targetTerritoryId:
              existing && existing.playerId !== myPlayerId ? existing.id : null,
            regionIds: [...new Set(loop.coordinates.map(coordinateRegionId))],
          };
        });

      if (newTerritories.length === 0) return;

      const hasPendingSteal = newTerritories.some(
        (territory) => Boolean(territory.targetTerritoryId),
      );
      const hasPendingGlobalSync = newTerritories.some(
        (territory) => territory.status === "pending_global_sync",
      );
      showFeedback({
        id: "territory-capture",
        type:
          hasPendingSteal || hasPendingGlobalSync
            ? "warning"
            : playerProfile.globalId
              ? "info"
              : "success",
        message: hasPendingSteal
          ? isOnlineRef.current
            ? "Intento de captura iniciado"
            : "Captura pendiente de sincronizar"
          : hasPendingGlobalSync
            ? "Territorio guardado · pendiente de sincronizar"
            : playerProfile.globalId
              ? "Territorio enviado para validar"
              : "Territorio conquistado",
      });
      void sendLocalGameNotification({
        category: "territories",
        eventKey: `territory_candidate:${newTerritories.map((item) => item.id).join(":")}`,
        title: hasPendingSteal || hasPendingGlobalSync
          ? "Territorio pendiente de validación"
          : "Territorio conquistado",
        body: hasPendingSteal || hasPendingGlobalSync
          ? "Tu conquista será validada cuando termine la sincronización."
          : "Tu nuevo territorio fue guardado.",
        url: `paintfoot://territory/${newTerritories[0].id}`,
        territoryId: newTerritories[0].id,
      });

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
        const next = [
          ...previousTerritories,
          ...newTerritories.filter(
            (candidate) =>
              !previousTerritories.some((territory) => territory.id === candidate.id),
          ),
        ];
        setTotalAreaM2(next.reduce((total, territory) => total + territory.areaM2, 0));
        return next;
      });
      void appendStoredTerritories(newTerritories)
        .then(async () => {
          debugLog("TERRITORY", "Guardado correctamente.");
          if (!playerProfile.globalId) return;
          const activeSession = await getRecoverableTrackingSession();
          const candidatesWithSession = newTerritories.map((candidate) => ({
            ...candidate,
            captureSessionId: activeSession?.id ?? null,
          }));
          for (const candidate of candidatesWithSession) {
            await updateStoredTerritory(candidate);
          }
          if (!isOnlineRef.current) return;
          for (const candidate of candidatesWithSession) {
            const result = await confirmGlobalTerritoryCapture(
              candidate,
              activeSession?.id ?? null,
            );
            if (result.reason === "protected") {
              showFeedback({
                id: "territory-protected",
                type: "warning",
                message: "Territorio protegido",
              });
              void sendLocalGameNotification({
                category: "territories",
                eventKey: `territory_rejected:${candidate.id}:protected`,
                title: "Conquista rechazada",
                body: "El territorio estaba protegido.",
                url: `paintfoot://territory/${candidate.id}`,
                territoryId: candidate.id,
              });
              const stored = await discardStoredPendingCapture(candidate.id);
              territoriesRef.current = stored;
              setTerritories(stored);
              continue;
            }
            if (result.reason !== "confirmed") {
              showFeedback({
                id: "territory-capture",
                type: "error",
                message: candidate.targetTerritoryId
                  ? "No se pudo capturar el territorio"
                  : "Territorio no válido",
              });
              void sendLocalGameNotification({
                category: "territories",
                eventKey: `territory_rejected:${candidate.id}`,
                title: "Conquista rechazada",
                body: "La conquista no pudo validarse.",
                url: `paintfoot://territory/${candidate.id}`,
                territoryId: candidate.id,
              });
              continue;
            }
            const stored = await resolveStoredGlobalCapture(
              candidate.id,
              result.territory,
            );
            territoriesRef.current = stored;
            setTerritories(stored);
            showFeedback({
              id: "territory-capture",
              type: candidate.targetTerritoryId ? "success" : "success",
              message: candidate.targetTerritoryId
                ? "Territorio robado"
                : "Territorio conquistado",
            });
            void sendLocalGameNotification({
              category: "territories",
              eventKey: `territory_validated:${result.territory.id}`,
              title: candidate.targetTerritoryId ? "Territorio robado" : "Territorio conquistado",
              body: candidate.targetTerritoryId
                ? "La captura fue validada."
                : "Tu nuevo territorio fue guardado.",
              url: `paintfoot://territory/${result.territory.id}`,
              territoryId: result.territory.id,
            });
          }
        })
        .catch((error) => {
          console.warn("No se pudieron guardar los territorios:", error);
        });
    },
    [myPlayerId, playerProfile.color, playerProfile.globalId, playerProfile.name],
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
            showFeedback({
              id: "road-cache-updated",
              type: "success",
              message: "Mapas guardados actualizados",
              cooldownMs: 300_000,
            });
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
        setRoadsUsingCache(result.source === "cache");
        await setActiveTrackingCacheCoverage(
          result.source === "cache"
            ? result.cacheCoverageComplete
              ? "complete"
              : "partial"
            : "network",
        );
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
          showFeedback({
            id: "road-cache-active",
            type: "info",
            message: "Usando mapas guardados",
            cooldownMs: 30_000,
          });
          debugLog("ROAD", "Recorrido validado con calles guardadas en el dispositivo.");
        }
        debugLog(
          "NODE",
          `${graph.nodes.length} nodos; ${graph.intersectionCount} intersecciones recorridas.`,
        );
        if (result.source !== "cache" || result.cacheCoverageComplete) {
          recordDetectedTerritories(nextTrack, analyzeFromSegment);
        } else {
          setHasPendingSavedRoute(true);
          showFeedback({
            id: "road-cache-insufficient",
            type: "warning",
            message: "Sin caché vial suficiente",
            cooldownMs: 30_000,
          });
          debugLog(
            "ROAD",
            "La cobertura vial guardada es parcial; el cierre esperara validacion.",
          );
        }
        if (capturedRawCount < rawTrackRef.current.length) {
          roadMatchQueuedRef.current = true;
        }
        return true;
      } catch {
        if (generation !== trackingGenerationRef.current) return false;
        if (!isOnlineRef.current) {
          await setActiveTrackingCacheCoverage("partial");
          const provisional = detectProvisionalOfflineCandidate(rawTrack);
          if (provisional) {
            const activeSession = await getRecoverableTrackingSession();
            if (activeSession) {
              await savePendingTerritory({
                id: `pending-${activeSession.id}`,
                sessionId: activeSession.id,
                rawTrack,
                sensorEvidence,
                candidatePolygon: provisional.polygon,
                createdOffline: true,
                status: "pending_validation",
                reason: "Perimetro cerrado pendiente de validacion vial.",
                createdAt: Date.now(),
              });
              setHasPendingSavedRoute(true);
              showFeedback({
                id: "territory-validation",
                type: "warning",
                message: "Territorio pendiente de validación",
              });
            }
          }
        }
        setRoadMatchStatus("pending");
        debugLog(
          "ROAD",
          "Recorrido guardado en el dispositivo; se validara cuando haya conexion.",
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
    [recordDetectedTerritories, sensorEvidence],
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
        const pendingSession = await getTrackingSessionById(pending.sessionId);
        if (
          pendingSession &&
          isActiveOfflineSessionStatus(pendingSession.status)
        ) {
          continue;
        }
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
            const territory = createTerritoryFromLoop(
              loop,
              playerProfile,
              createdAt + index,
              index,
            );
            const isPendingSteal = Boolean(
              existing && existing.playerId !== myPlayerId,
            );
            return [{
              ...territory,
              status: !playerProfile.globalId
                ? "confirmed"
                : isPendingSteal
                  ? "pending_capture"
                  : "pending_global_sync",
              targetTerritoryId: isPendingSteal ? existing?.id ?? null : null,
              captureSessionId: pending.sessionId,
              regionIds: [...new Set(loop.coordinates.map(coordinateRegionId))],
            }];
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
          if (loops.length === 0) {
            showFeedback({
              id: "territory-validation",
              type: "error",
              message: "Territorio no válido",
            });
          }
          if (newTerritories.length > 0) {
            publishOfflineSyncStatus(
              "syncing",
              "Territorio enviado para validar",
            );
            await synchronizePendingOperations();
          }
        } catch {
          debugLog(
            "ROAD",
            "La validacion sigue pendiente y se intentara nuevamente con una conexion estable.",
          );
          break;
        }
      }
      const remaining = await getPendingTerritories();
      const remainingFinalizable = [];
      for (const pending of remaining) {
        const session = await getTrackingSessionById(pending.sessionId);
        if (!session || !isActiveOfflineSessionStatus(session.status)) {
          remainingFinalizable.push(pending);
        }
      }
      setHasPendingSavedRoute(
        !isTrackingRef.current && remaining.length > 0,
      );
      if (
        remainingFinalizable.length === 0 &&
        getOfflineSyncSnapshot().status === "syncing"
      ) {
        publishOfflineSyncStatus("synced", "Sincronizado");
      }
    } finally {
      pendingSyncInFlightRef.current = false;
    }
  }, [myPlayerId, playerProfile]);

  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    void (async () => {
      if (isTrackingRef.current) {
        await markStoredRouteConnectionState("active_syncing");
      }
      await synchronizePendingRoutes();
      await synchronizePendingOperations();
      if (rawTrackRef.current.length >= 2) {
        await runRoadMatchRef.current(true);
      }
      if (!cancelled && isTrackingRef.current) {
        await markStoredRouteConnectionState("active_local");
      }
    })();
    return () => {
      cancelled = true;
    };
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

  useEffect(
    () => registerGameSystemActions({
      selectTheme,
      retryRoadMatching: () => scheduleRoadMatch(true),
      openNotificationSettings: () => void launchNotificationSettings(),
    }),
    [launchNotificationSettings, scheduleRoadMatch, selectTheme],
  );

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
        showFeedback({
          id: "gps-low-accuracy",
          type: "warning",
          message: "GPS con baja precisión · buscando mejor señal",
          cooldownMs: 30_000,
        });
        persistPoint(false);
        return false;
      }

      const newCoord: Coordinate = {
        latitude: point.latitude,
        longitude: point.longitude,
        timestamp: point.timestamp,
      };
      const previousCoordinate = lastAcceptedCoordinateRef.current;

      if (
        !shouldAcceptStableGpsUpdate(previousCoordinate, newCoord, {
          accuracyMeters: point.accuracy,
          reportedSpeedMps: point.speed,
          sensorMoving: sensor?.moving,
          tracking: true,
          baseDistanceMeters: MINIMUM_POINT_DISTANCE_METERS,
          maximumSpeedMps: MAX_ACCEPTABLE_SPEED_MPS,
        })
      ) {
        persistPoint(false);
        return false;
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
      if (isTrackingRef.current) {
        const nearbyCoins = activeCoinsRef.current.filter(
          (coin) =>
            (!coin.availableAt || Date.now() >= coin.availableAt) &&
            distanceInMeters(coin, newCoord) <= 15,
        );
        if (nearbyCoins.length > 0) {
          void Promise.all(nearbyCoins.map((coin) => collectCoin(coin, myPlayerId))).then(
            (results) => {
              const collectedIds = new Set(
                nearbyCoins.filter((_, index) => results[index]).map((coin) => coin.id),
              );
              if (collectedIds.size === 0) return;
              activeCoinsRef.current = activeCoinsRef.current.filter(
                (coin) => !collectedIds.has(coin.id),
              );
              setActiveCoins(activeCoinsRef.current);
              void getCoinBalance().then(setCoinBalance);
              showFeedback({
                id: "coin-collected",
                type: "success",
                message: `Moneda recogida · +${collectedIds.size}`,
              });
              void sendLocalGameNotification({
                category: "coins",
                eventKey: `coins_collected:${Math.floor(Date.now() / 60_000)}`,
                title: "Recompensa agregada",
                body: "Tus monedas fueron guardadas.",
                url: "paintfoot://coins",
                cooldownMs: 60_000,
              });
            },
          );
        }
      }
      mapRef.current?.injectJavaScript(
        `window.setCoins?.(${JSON.stringify(activeCoinsRef.current)}); true;`,
      );
      persistPoint(true);
      if (isOnlineRef.current) {
        void prefetchRoadRegionsNear(newCoord);
      }

      mapRef.current?.injectJavaScript(
        `window.setUserLocation(${newCoord.latitude}, ${newCoord.longitude}, false); true;`,
      );
      if (multiplayerPreferencesRef.current.shareRealtimeLocation) {
        sendPlayerLocation(
          wsRef.current,
          myPlayerId,
          newCoord,
          playerProfile.color,
        );
      }
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
    if (roadMatchStatus !== "pending" || rawTrackRef.current.length < 2) return;
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

      isTrackingRef.current = true;
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
        if (motionSensorTrackerRef.current.getPermissionIssues().length > 0) {
          showFeedback({
            id: "sensor-permission-denied",
            type: "warning",
            message: "Sin permiso de movimiento o pasos; el recorrido usará solo GPS.",
          });
        }
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
      showFeedback({
        id: "tracking-start-error",
        type: "error",
        message: "No se pudo iniciar recorrido",
      });
      isTrackingRef.current = false;
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
      isTrackingRef.current = false;
      setIsTracking(false);
      if (isOnlineRef.current) {
        void synchronizePendingRoutes();
      }
    }
  }, [importStoredRoutePoints, sensorEvidence, synchronizePendingRoutes]);

  useEffect(() => {
    if (mapStatus !== "ready") return;
    mapRef.current?.injectJavaScript(
      `window.setRoute(${JSON.stringify(routeCoords)}); true;`,
    );
  }, [mapStatus, routeCoords]);

  useEffect(() => {
    if (mapStatus !== "ready") return;
    const visibleTerritories = territories.filter(
      (territory) =>
        territory.status !== "rejected" &&
        (multiplayerPreferences.showOtherTerritories ||
          territory.playerId === myPlayerId),
    );
    const mapTerritories = visibleTerritories.map((territory) => {
      const isMine = territory.playerId === myPlayerId;
      const color = isMine
        ? playerProfile.color
        : contrastingMapColor(playerProfile.color);
      return { ...territory, color, playerColor: color };
    });
    mapRef.current?.injectJavaScript(
      `window.setTerritories(${JSON.stringify(mapTerritories)}); true;`,
    );
  }, [
    mapStatus,
    multiplayerPreferences.showOtherTerritories,
    myPlayerId,
    playerProfile.color,
    territories,
  ]);

  useEffect(() => {
    if (mapStatus !== "ready" || typeof requestedTerritoryId !== "string") return;
    const exists = territories.some((territory) => territory.id === requestedTerritoryId);
    if (!exists) return;
    mapRef.current?.injectJavaScript(
      `window.focusTerritory?.(${JSON.stringify(requestedTerritoryId)}); true;`,
    );
  }, [mapStatus, requestedTerritoryId, territories]);

  useEffect(() => {
    if (!location || !playerProfile.globalId) return;
    void globalMultiplayerRef.current?.update(
      location,
      playerProfile,
      multiplayerPreferences,
      routeCoords,
    );
  }, [location, multiplayerPreferences, playerProfile, routeCoords]);

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
          void synchronizeGlobalTerritoryShield(updated);
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
  const panelTextColor = lightTheme ? Palette.navy800 : Palette.white;
  const secondaryTextColor = lightTheme ? Palette.navy600 : Palette.textSoft;

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
            if (message.type === "coin-region-request" && message.detail) {
              const requested = JSON.parse(message.detail) as {
                latitude?: number;
                longitude?: number;
              };
              if (
                Number.isFinite(requested.latitude) &&
                Number.isFinite(requested.longitude)
              ) {
                const nextCenter: Coordinate = {
                  latitude: requested.latitude!,
                  longitude: requested.longitude!,
                };
                const previousCenter = coinViewportCenterRef.current;
                if (
                  !previousCenter ||
                  distanceInMeters(previousCenter, nextCenter) >=
                    COIN_LOAD_RADIUS_METERS / 4
                ) {
                  coinViewportCenterRef.current = nextCenter;
                  setCoinViewportCenter(nextCenter);
                }
              }
            }
            if (message.type === "map-error") {
              console.warn("Error del mapa:", message.detail ?? "desconocido");
              setMapStatus("error");
            }
            if (message.type === "coin-viewport" && message.detail) {
              const diagnostics = JSON.parse(message.detail) as {
                stored?: number;
                inViewport?: number;
                hiddenByPanel?: number;
                rendered?: number;
                reason?: string;
              };
              if (DEBUG_COINS) {
                console.info(
                  `[Coins] SQLite/mapa: ${diagnostics.stored ?? 0} · viewport: ${diagnostics.inViewport ?? 0} · ocultas por panel: ${diagnostics.hiddenByPanel ?? 0} · renderizadas: ${diagnostics.rendered ?? 0} · ${diagnostics.reason ?? "sin detalle"}`,
                );
              }
              const renderedCoins = diagnostics.rendered ?? 0;
              const fallbackAreaId = currentCoinProximityId
                ? `${currentCoinRegionId}:${currentCoinProximityId}`
                : null;
              if (renderedCoins >= WORLD_COIN_MINIMUM_NEARBY_VISIBLE) {
                coinFallbackRegionRef.current = null;
              }
              if (
                renderedCoins < WORLD_COIN_MINIMUM_NEARBY_VISIBLE &&
                location &&
                currentCoinRegionId &&
                fallbackAreaId &&
                roadSegmentsRef.current.length > 0 &&
                coinFallbackRegionRef.current !== fallbackAreaId
              ) {
                coinFallbackRegionRef.current = fallbackAreaId;
                const fallbackCenter = effectiveCoinCenter ?? location;
                const fallbackSeed = createRegionalStreetCoins(
                  fallbackCenter,
                  roadSegmentsRef.current,
                ).slice(0, WORLD_COIN_MINIMUM_NEARBY_VISIBLE * 6);
                void filterUncollectedCoins(fallbackSeed).then((visibleSeed) => {
                  if (visibleSeed.length === 0) return;
                  const merged = new Map<string, MapCoin>();
                  visibleSeed.forEach((coin) => merged.set(coin.id, coin));
                  activeCoinsRef.current.forEach((coin) => {
                    if (merged.size < COIN_ACTIVE_MEMORY_LIMIT) merged.set(coin.id, coin);
                  });
                  const nextCoins = [...merged.values()].slice(0, COIN_ACTIVE_MEMORY_LIMIT);
                  activeCoinsRef.current = nextCoins;
                  setActiveCoins(nextCoins);
                  mapRef.current?.injectJavaScript(
                    `window.setCoins?.(${JSON.stringify(nextCoins)}); true;`,
                  );
                  void saveWorldCoinCatalog(visibleSeed, myPlayerId).catch(() => undefined);
                  if (DEBUG_COINS) {
                    console.info(
                      `[Coins] refuerzo vial cercano: ${visibleSeed.length} (faltaban ${Math.max(0, WORLD_COIN_MINIMUM_NEARBY_VISIBLE - renderedCoins)})`,
                    );
                  }
                });
              }
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

      {/* Panel de controles */}
      <View
        onLayout={({ nativeEvent }) => {
          const panelHeight = Math.ceil(nativeEvent.layout.height);
          mapRef.current?.injectJavaScript(
            `window.setMapBottomInset?.(${panelHeight}); true;`,
          );
        }}
        style={[
          styles.controlPanel,
          {
            bottom: Math.max(insets.bottom + 8, Platform.OS === "ios" ? 40 : 24),
            maxHeight: Math.max(210, height * 0.48),
            backgroundColor: lightTheme
              ? Palette.overlayLight
              : Palette.overlayNavy,
          },
        ]}
      >
        <ScrollView
          bounces={false}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.controlPanelContent,
            compactLayout && styles.controlPanelContentCompact,
          ]}
        >
        {/* Indicador de estado */}
        <View style={styles.statusContainer}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: isTracking ? Palette.successStrong : Palette.textMuted },
            ]}
          />
          <Text style={[styles.statusText, { color: panelTextColor }]}>
            {isTracking ? "Recorrido activo" : "Recorrido detenido"}
          </Text>
          <Text style={styles.coinBalance}>🪙 {coinBalance}</Text>
          {territories.length > 0 && (
            <Text style={styles.territoryCount}>
              {territories.length} territorio
              {territories.length !== 1 ? "s" : ""}
            </Text>
          )}
        </View>

        {totalAreaM2 > 0 && (
          <Text style={styles.territoryAreaText}>
            Area total: {Math.round(totalAreaM2).toLocaleString()} m²
          </Text>
        )}

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
        </ScrollView>
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
    backgroundColor: Palette.overlayLightSoft,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 3,
  },
  attributionText: {
    color: Palette.navy900,
    fontSize: 10,
  },
  loadingBadge: {
    position: "absolute",
    top: 54,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Palette.overlayNavy,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  loadingBadgeText: {
    color: Palette.white,
    fontSize: 13,
    fontWeight: "600",
  },
  errorBanner: {
    position: "absolute",
    top: 54,
    left: 16,
    right: 16,
    backgroundColor: Palette.overlayNavy,
    borderRadius: 12,
    padding: 12,
  },
  retryButton: {
    alignSelf: "center",
    backgroundColor: Palette.white,
    borderRadius: 8,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  retryButtonText: {
    color: Palette.navy950,
    fontSize: 13,
    fontWeight: "700",
  },
  mapErrorBanner: {
    position: "absolute",
    top: 116,
    left: 16,
    right: 16,
    backgroundColor: Palette.overlayNavy,
    borderRadius: 12,
    padding: 12,
  },
  mapErrorText: {
    color: Palette.white,
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
    backgroundColor: Palette.overlayNavy,
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
    color: Palette.white,
    fontSize: 12,
    fontWeight: "600",
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Palette.navy900,
    padding: 32,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: Palette.textSoft,
    fontWeight: "500",
  },
  errorIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  errorText: {
    fontSize: 16,
    color: Palette.textSoft,
    textAlign: "center",
    lineHeight: 24,
  },
  controlPanel: {
    position: "absolute",
    left: 16,
    right: 16,
    backgroundColor: Palette.overlayNavy,
    borderRadius: 20,
    overflow: "hidden",
    // Sombra
    shadowColor: Palette.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  controlPanelContent: { gap: 16, padding: 20 },
  controlPanelContentCompact: { gap: 12, padding: 14 },
  statusContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
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
    color: Palette.white,
    flex: 1,
  },
  coinBalance: {
    color: Palette.gold,
    fontSize: 15,
    fontWeight: "900",
  },
  coordCount: {
    fontSize: 13,
    color: Palette.textMuted,
  },
  territoryCount: {
    fontSize: 13,
    color: Palette.textSecondary,
  },
  territoryAreaText: {
    color: Palette.success,
    fontSize: 13,
    fontWeight: "700",
  },
  backgroundStatusText: {
    color: Palette.textSoft,
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
    backgroundColor: Palette.navy500,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  intentButtonText: {
    color: Palette.white,
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
    backgroundColor: Palette.ice100,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  themeButtonActive: {
    backgroundColor: Palette.navy500,
  },
  themeButtonText: {
    color: Palette.navy700,
    fontSize: 11,
    fontWeight: "700",
  },
  themeButtonTextActive: {
    color: Palette.white,
  },
  sensorSummary: {
    gap: 4,
  },
  sensorText: {
    fontSize: 12,
    lineHeight: 17,
  },
  magneticWarning: {
    color: Palette.warning,
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
    backgroundColor: Palette.successStrong,
  },
  stopButton: {
    backgroundColor: Palette.danger,
  },
  actionButtonText: {
    fontSize: 16,
    fontWeight: "700",
    color: Palette.white,
    letterSpacing: 0.5,
  },
});
