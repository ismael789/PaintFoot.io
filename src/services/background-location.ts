import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

import {
  appendOfflineTrackingPoints,
  beginOfflineTrackingSession,
  getOfflineTrackingPoints,
  getRecoverableTrackingSession,
  initializeOfflineStorage,
  setActiveTrackingConnectionStatus,
  setTrackingSessionStatus,
} from "@/services/offline-storage";
import type { SensorEvidence } from "@/types/game";

export const BACKGROUND_LOCATION_TASK = "paintfoot-background-location";

// Solo se conservan para migrar recorridos creados por versiones anteriores.
const LEGACY_ROUTE_STORAGE_KEY = "@paintfoot/active-route";
const LEGACY_SESSION_STORAGE_KEY = "@paintfoot/active-route-session-v1";

export interface StoredLocationPoint {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  heading?: number | null;
  speed?: number | null;
  timestamp: number;
  sensor?: SensorEvidence;
  accepted?: boolean;
}

export interface StoredRouteSession {
  id: string;
  playerId: string;
  startedAt: number;
  stoppedAt: number | null;
  pendingRoadMatch: boolean;
}

interface BackgroundLocationTaskData {
  locations: Location.LocationObject[];
}

let migrationPromise: Promise<void> | null = null;

function toStoredPoint(location: Location.LocationObject): StoredLocationPoint {
  return {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracy: location.coords.accuracy,
    heading: location.coords.heading,
    speed: location.coords.speed,
    timestamp: location.timestamp,
  };
}

function toStoredSession(
  session: Awaited<ReturnType<typeof getRecoverableTrackingSession>>,
): StoredRouteSession | null {
  return session
    ? {
        id: session.id,
        playerId: session.playerId,
        startedAt: session.startedAt,
        stoppedAt: session.stoppedAt,
        pendingRoadMatch: session.pendingRoadMatch,
      }
    : null;
}

async function migrateLegacyRouteOnce() {
  await initializeOfflineStorage();
  const existing = await getRecoverableTrackingSession();
  if (existing) return;

  const [legacySessionValue, legacyPointsValue] = await AsyncStorage.multiGet([
    LEGACY_SESSION_STORAGE_KEY,
    LEGACY_ROUTE_STORAGE_KEY,
  ]);
  const rawSession = legacySessionValue[1];
  const rawPoints = legacyPointsValue[1];
  if (!rawPoints) {
    await AsyncStorage.multiRemove([
      LEGACY_SESSION_STORAGE_KEY,
      LEGACY_ROUTE_STORAGE_KEY,
    ]);
    return;
  }

  try {
    const points = JSON.parse(rawPoints) as StoredLocationPoint[];
    const parsedSession = rawSession
      ? (JSON.parse(rawSession) as Partial<StoredRouteSession>)
      : null;
    if (points.length > 0) {
      const startedAt =
        typeof parsedSession?.startedAt === "number"
          ? parsedSession.startedAt
          : points[0].timestamp;
      await beginOfflineTrackingSession(
        typeof parsedSession?.playerId === "string"
          ? parsedSession.playerId
          : "local-player",
        startedAt,
        true,
      );
      await appendOfflineTrackingPoints(points, true);
      await setTrackingSessionStatus(
        parsedSession?.pendingRoadMatch === true
          ? "pending_sync"
          : "active_local",
        typeof parsedSession?.stoppedAt === "number"
          ? parsedSession.stoppedAt
          : null,
        parsedSession?.pendingRoadMatch === true,
      );
    }
  } catch (error) {
    console.warn("[Offline] No se pudo migrar el recorrido anterior:", error);
  } finally {
    await AsyncStorage.multiRemove([
      LEGACY_SESSION_STORAGE_KEY,
      LEGACY_ROUTE_STORAGE_KEY,
    ]);
  }
}

function ensureStorageReady() {
  migrationPromise ??= migrateLegacyRouteOnce();
  return migrationPromise;
}

export async function appendStoredRoutePoints(
  points: StoredLocationPoint[],
  createdOffline = false,
) {
  if (points.length === 0) return;
  await ensureStorageReady();
  await appendOfflineTrackingPoints(points, createdOffline);
}

export async function getStoredRoutePoints() {
  await ensureStorageReady();
  const points = await getOfflineTrackingPoints();
  return points.filter((point) => point.accepted).map<StoredLocationPoint>((point) => ({
    latitude: point.latitude,
    longitude: point.longitude,
    accuracy: point.accuracy,
    heading: point.heading,
    speed: point.speed,
    timestamp: point.wallClockTimestamp,
    sensor: point.sensor,
    accepted: true,
  }));
}

export async function clearStoredRoutePoints() {
  await ensureStorageReady();
  await setTrackingSessionStatus("completed", Date.now(), false);
}

export async function beginStoredRouteSession(
  playerId: string,
  startedAt = Date.now(),
  createdOffline = false,
) {
  await ensureStorageReady();
  return toStoredSession(
    await beginOfflineTrackingSession(playerId, startedAt, createdOffline),
  )!;
}

export async function getStoredRouteSession() {
  await ensureStorageReady();
  return toStoredSession(await getRecoverableTrackingSession());
}

export async function markStoredRoutePending(stoppedAt = Date.now()) {
  await ensureStorageReady();
  await setTrackingSessionStatus("pending_sync", stoppedAt, true);
}

export async function markStoredRouteActive() {
  await ensureStorageReady();
  await setTrackingSessionStatus("active_local", null, false);
}

export async function markStoredRouteConnectionState(
  state: "active_local" | "active_offline" | "active_syncing",
) {
  await ensureStorageReady();
  await setActiveTrackingConnectionStatus(state);
}

export async function clearStoredRouteSession() {
  await ensureStorageReady();
  await setTrackingSessionStatus("completed", Date.now(), false);
}

if (!TaskManager.isTaskDefined(BACKGROUND_LOCATION_TASK)) {
  TaskManager.defineTask<BackgroundLocationTaskData>(
    BACKGROUND_LOCATION_TASK,
    async ({ data, error }) => {
      if (error) {
        console.error("[GPS background]", error.message);
        return;
      }
      if (!data?.locations?.length) return;

      const network = await NetInfo.fetch().catch(() => null);
      const createdOffline =
        network === null ||
        network.isConnected === false ||
        network.isInternetReachable === false;
      await appendStoredRoutePoints(
        data.locations.map(toStoredPoint),
        createdOffline,
      );
    },
  );
}
