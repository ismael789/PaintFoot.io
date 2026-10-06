import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";

import type {
  GeoJsonPolygon,
  RawTrackPoint,
  RoadSegment,
  SensorEvidence,
  Territory,
} from "@/types/game";

const DATABASE_NAME = "paintfoot-offline.db";
const DATABASE_VERSION = 2;
const ROAD_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ROAD_CACHE_MAX_SEGMENTS = 5_000;
const CLOCK_BACKWARDS_TOLERANCE_MS = 5_000;

export type OfflineSessionStatus =
  | "active"
  | "pending_sync"
  | "synced"
  | "completed";

export interface OfflineTrackingSession {
  id: string;
  playerId: string;
  startedAt: number;
  stoppedAt: number | null;
  pendingRoadMatch: boolean;
  status: OfflineSessionStatus;
  clockAnomaly: boolean;
  createdOffline: boolean;
}

export interface OfflineTrackingPoint extends RawTrackPoint {
  sessionId: string;
  sequence: number;
  wallClockTimestamp: number;
  monotonicTimestamp: number;
  sensorConfidence: number | null;
  createdOffline: boolean;
  previousHash: string;
  currentHash: string;
  clockAnomaly: boolean;
  accepted: boolean;
}

export interface PendingTerritoryRecord {
  id: string;
  sessionId: string;
  rawTrack: RawTrackPoint[];
  sensorEvidence: SensorEvidence | null;
  candidatePolygon: GeoJsonPolygon | null;
  createdOffline: boolean;
  status: "pending_validation" | "confirmed" | "rejected";
  reason: string;
  createdAt: number;
  updatedAt: number;
}

export interface OfflineStorageStats {
  trackingSessionsCount: number;
  trackingPointsCount: number;
  territoriesCount: number;
  pendingTerritoriesCount: number;
  roadCacheSize: number;
  localStorageUsed: number;
}

interface SessionRow {
  id: string;
  player_id: string;
  started_at: number;
  stopped_at: number | null;
  pending_road_match: number;
  status: OfflineSessionStatus;
  clock_anomaly: number;
  created_offline: number;
  last_sequence: number;
  last_hash: string;
  last_wall_clock: number | null;
}

interface PointRow {
  session_id: string;
  sequence: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  wall_clock_timestamp: number;
  monotonic_timestamp: number;
  sensor_confidence: number | null;
  created_offline: number;
  sensor_json: string | null;
  previous_hash: string;
  current_hash: string;
  clock_anomaly: number;
  accepted: number;
}

interface TerritoryRow {
  payload_json: string;
}

interface PendingTerritoryRow {
  id: string;
  session_id: string;
  raw_track_json: string;
  sensor_evidence_json: string | null;
  candidate_polygon_json: string | null;
  created_offline: number;
  status: PendingTerritoryRecord["status"];
  reason: string;
  created_at: number;
  updated_at: number;
}

interface TrustedTimeRow {
  server_time: number;
  monotonic_time: number;
  boot_id: string;
}

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let operationQueue: Promise<void> = Promise.resolve();
const bootId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function monotonicNow() {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : 0;
}

function serializeOperation<T>(operation: () => Promise<T>) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function openDatabase() {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync(DATABASE_NAME).then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS tracking_sessions (
          id TEXT PRIMARY KEY NOT NULL,
          player_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          stopped_at INTEGER,
          pending_road_match INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          clock_anomaly INTEGER NOT NULL DEFAULT 0,
          created_offline INTEGER NOT NULL DEFAULT 0,
          last_sequence INTEGER NOT NULL DEFAULT 0,
          last_hash TEXT NOT NULL DEFAULT '',
          last_wall_clock INTEGER
        );
        CREATE TABLE IF NOT EXISTS tracking_points (
          session_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          accuracy REAL,
          speed REAL,
          heading REAL,
          wall_clock_timestamp INTEGER NOT NULL,
          monotonic_timestamp REAL NOT NULL,
          sensor_confidence REAL,
          created_offline INTEGER NOT NULL DEFAULT 0,
          sensor_json TEXT,
          previous_hash TEXT NOT NULL,
          current_hash TEXT NOT NULL,
          clock_anomaly INTEGER NOT NULL DEFAULT 0,
          accepted INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (session_id, sequence),
          FOREIGN KEY (session_id) REFERENCES tracking_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_tracking_points_session_time
          ON tracking_points(session_id, sequence);
        CREATE TABLE IF NOT EXISTS sensor_events (
          session_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          wall_clock_timestamp INTEGER NOT NULL,
          monotonic_timestamp REAL NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (session_id, sequence),
          FOREIGN KEY (session_id) REFERENCES tracking_sessions(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS territories (
          id TEXT PRIMARY KEY NOT NULL,
          signature TEXT NOT NULL UNIQUE,
          player_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pending_territories (
          id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          raw_track_json TEXT NOT NULL,
          sensor_evidence_json TEXT,
          candidate_polygon_json TEXT,
          created_offline INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS road_cache (
          id TEXT PRIMARY KEY NOT NULL,
          segment_json TEXT NOT NULL,
          min_lat REAL NOT NULL,
          max_lat REAL NOT NULL,
          min_lon REAL NOT NULL,
          max_lon REAL NOT NULL,
          last_accessed INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_road_cache_bounds
          ON road_cache(min_lat, max_lat, min_lon, max_lon);
        CREATE TABLE IF NOT EXISTS sync_queue (
          id TEXT PRIMARY KEY NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          action TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(entity_type, entity_id, action)
        );
        CREATE TABLE IF NOT EXISTS trusted_time (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          server_time INTEGER NOT NULL,
          monotonic_time REAL NOT NULL,
          boot_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      const version = await db.getFirstAsync<{ user_version: number }>(
        "PRAGMA user_version",
      );
      if ((version?.user_version ?? 0) === 1) {
        await db.execAsync(
          "ALTER TABLE tracking_points ADD COLUMN accepted INTEGER NOT NULL DEFAULT 1",
        );
      }
      if ((version?.user_version ?? 0) < DATABASE_VERSION) {
        await db.execAsync(`PRAGMA user_version = ${DATABASE_VERSION}`);
      }
      return db;
    });
  }
  return databasePromise;
}

export async function initializeOfflineStorage() {
  await openDatabase();
}

function sessionFromRow(row: SessionRow): OfflineTrackingSession {
  return {
    id: row.id,
    playerId: row.player_id,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    pendingRoadMatch: row.pending_road_match === 1,
    status: row.status,
    clockAnomaly: row.clock_anomaly === 1,
    createdOffline: row.created_offline === 1,
  };
}

export function beginOfflineTrackingSession(
  playerId: string,
  startedAt = Date.now(),
  createdOffline = false,
) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const id = `route-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await db.runAsync(
      `INSERT INTO tracking_sessions
       (id, player_id, started_at, stopped_at, pending_road_match, status, created_offline)
       VALUES (?, ?, ?, NULL, 0, 'active', ?)`,
      id,
      playerId,
      startedAt,
      createdOffline ? 1 : 0,
    );
    return {
      id,
      playerId,
      startedAt,
      stoppedAt: null,
      pendingRoadMatch: false,
      status: "active" as const,
      clockAnomaly: false,
      createdOffline,
    };
  });
}

export function getRecoverableTrackingSession() {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const row = await db.getFirstAsync<SessionRow>(
      `SELECT * FROM tracking_sessions
       WHERE status IN ('active', 'pending_sync')
       ORDER BY started_at DESC LIMIT 1`,
    );
    return row ? sessionFromRow(row) : null;
  });
}

export function setTrackingSessionStatus(
  status: OfflineSessionStatus,
  stoppedAt: number | null,
  pendingRoadMatch: boolean,
) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const session = await db.getFirstAsync<SessionRow>(
      `SELECT * FROM tracking_sessions
       WHERE status IN ('active', 'pending_sync')
       ORDER BY started_at DESC LIMIT 1`,
    );
    if (!session) return;
    await db.runAsync(
      `UPDATE tracking_sessions
       SET status = ?, stopped_at = ?, pending_road_match = ?
       WHERE id = ?`,
      status,
      stoppedAt,
      pendingRoadMatch ? 1 : 0,
      session.id,
    );
  });
}

function confidenceFromSensor(sensor?: SensorEvidence) {
  if (!sensor) return null;
  let available = 0;
  let active = 0;
  for (const value of Object.values(sensor.availability)) {
    if (value) available += 1;
  }
  if (sensor.moving === true) active += 2;
  if (sensor.compassHeadingDegrees !== null) active += 1;
  if (sensor.gyroscopeRotationRateRadS !== null) active += 1;
  if (sensor.accelerationDeltaG !== null) active += 1;
  if (sensor.sessionStepCount !== null && sensor.sessionStepCount !== undefined) active += 1;
  return Math.min(1, active / Math.max(1, Math.min(available, 6)));
}

function canonicalPointPayload(input: {
  sessionId: string;
  sequence: number;
  point: RawTrackPoint;
  wallClockTimestamp: number;
  monotonicTimestamp: number;
  sensorConfidence: number | null;
  createdOffline: boolean;
  previousHash: string;
  accepted: boolean;
}) {
  return JSON.stringify({
    sessionId: input.sessionId,
    sequence: input.sequence,
    latitude: input.point.latitude,
    longitude: input.point.longitude,
    accuracy: input.point.accuracy,
    speed: input.point.speed ?? null,
    heading: input.point.heading ?? null,
    wallClockTimestamp: input.wallClockTimestamp,
    monotonicTimestamp: input.monotonicTimestamp,
    sensorConfidence: input.sensorConfidence,
    sensor: input.point.sensor ?? null,
    createdOffline: input.createdOffline,
    previousHash: input.previousHash,
    accepted: input.accepted,
  });
}

export function appendOfflineTrackingPoints(
  points: Array<RawTrackPoint & { accepted?: boolean }>,
  createdOffline: boolean,
) {
  if (points.length === 0) return Promise.resolve<OfflineTrackingPoint[]>([]);
  return serializeOperation(async () => {
    const db = await openDatabase();
    const session = await db.getFirstAsync<SessionRow>(
      `SELECT * FROM tracking_sessions
       WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`,
    );
    if (!session) return [];

    let sequence = session.last_sequence;
    let previousHash = session.last_hash;
    let previousWallClock = session.last_wall_clock;
    let sessionClockAnomaly = session.clock_anomaly === 1;
    const stored: OfflineTrackingPoint[] = [];

    await db.withExclusiveTransactionAsync(async (transaction) => {
      for (const point of points) {
        sequence += 1;
        const wallClockTimestamp = point.timestamp ?? Date.now();
        const monotonicTimestamp = monotonicNow();
        const sensorConfidence = confidenceFromSensor(point.sensor);
        const clockAnomaly =
          previousWallClock !== null &&
          wallClockTimestamp + CLOCK_BACKWARDS_TOLERANCE_MS < previousWallClock;
        sessionClockAnomaly ||= clockAnomaly;
        const currentHash = await Crypto.digestStringAsync(
          Crypto.CryptoDigestAlgorithm.SHA256,
          canonicalPointPayload({
            sessionId: session.id,
            sequence,
            point,
            wallClockTimestamp,
            monotonicTimestamp,
            sensorConfidence,
            createdOffline,
            previousHash,
            accepted: point.accepted !== false,
          }),
        );
        await transaction.runAsync(
          `INSERT OR IGNORE INTO tracking_points
           (session_id, sequence, latitude, longitude, accuracy, speed, heading,
            wall_clock_timestamp, monotonic_timestamp, sensor_confidence,
            created_offline, sensor_json, previous_hash, current_hash, clock_anomaly, accepted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          session.id,
          sequence,
          point.latitude,
          point.longitude,
          point.accuracy,
          point.speed ?? null,
          point.heading ?? null,
          wallClockTimestamp,
          monotonicTimestamp,
          sensorConfidence,
          createdOffline ? 1 : 0,
          point.sensor ? JSON.stringify(point.sensor) : null,
          previousHash,
          currentHash,
          clockAnomaly ? 1 : 0,
          point.accepted === false ? 0 : 1,
        );
        if (point.sensor) {
          await transaction.runAsync(
            `INSERT OR REPLACE INTO sensor_events
             (session_id, sequence, wall_clock_timestamp, monotonic_timestamp, payload_json)
             VALUES (?, ?, ?, ?, ?)`,
            session.id,
            sequence,
            wallClockTimestamp,
            monotonicTimestamp,
            JSON.stringify(point.sensor),
          );
        }
        stored.push({
          ...point,
          timestamp: wallClockTimestamp,
          sessionId: session.id,
          sequence,
          wallClockTimestamp,
          monotonicTimestamp,
          sensorConfidence,
          createdOffline,
          previousHash,
          currentHash,
          clockAnomaly,
          accepted: point.accepted !== false,
        });
        previousHash = currentHash;
        previousWallClock = wallClockTimestamp;
      }
      await transaction.runAsync(
        `UPDATE tracking_sessions
         SET last_sequence = ?, last_hash = ?, last_wall_clock = ?,
             clock_anomaly = ?, created_offline = MAX(created_offline, ?)
         WHERE id = ?`,
        sequence,
        previousHash,
        previousWallClock,
        sessionClockAnomaly ? 1 : 0,
        createdOffline ? 1 : 0,
        session.id,
      );
    });
    return stored;
  });
}

export function getOfflineTrackingPoints(sessionId?: string) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const resolvedSessionId =
      sessionId ??
      (
        await db.getFirstAsync<{ id: string }>(
          `SELECT id FROM tracking_sessions
           WHERE status IN ('active', 'pending_sync')
           ORDER BY started_at DESC LIMIT 1`,
        )
      )?.id;
    if (!resolvedSessionId) return [];
    const rows = await db.getAllAsync<PointRow>(
      `SELECT * FROM tracking_points WHERE session_id = ? ORDER BY sequence`,
      resolvedSessionId,
    );
    return rows.map<OfflineTrackingPoint>((row) => ({
      sessionId: row.session_id,
      sequence: row.sequence,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracy: row.accuracy,
      speed: row.speed,
      heading: row.heading,
      timestamp: row.wall_clock_timestamp,
      wallClockTimestamp: row.wall_clock_timestamp,
      monotonicTimestamp: row.monotonic_timestamp,
      sensorConfidence: row.sensor_confidence,
      createdOffline: row.created_offline === 1,
      sensor: row.sensor_json
        ? (JSON.parse(row.sensor_json) as SensorEvidence)
        : undefined,
      previousHash: row.previous_hash,
      currentHash: row.current_hash,
      clockAnomaly: row.clock_anomaly === 1,
      accepted: row.accepted === 1,
    }));
  });
}

export function saveOfflineTerritories(territories: Territory[]) {
  if (territories.length === 0) return Promise.resolve();
  return serializeOperation(async () => {
    const db = await openDatabase();
    await db.withExclusiveTransactionAsync(async (transaction) => {
      for (const territory of territories) {
        await transaction.runAsync(
          `INSERT OR REPLACE INTO territories
           (id, signature, player_id, created_at, payload_json)
           VALUES (?, ?, ?, ?, ?)`,
          territory.id,
          territory.signature,
          territory.playerId,
          territory.createdAt,
          JSON.stringify(territory),
        );
        const segmentIds = [
          ...new Set(
            territory.coordinates
              .map((coordinate) => coordinate.roadSegmentId)
              .filter((id): id is string => Boolean(id)),
          ),
        ];
        for (const segmentId of segmentIds) {
          await transaction.runAsync(
            "UPDATE road_cache SET pinned = 1 WHERE id = ?",
            segmentId,
          );
        }
      }
    });
  });
}

export function getOfflineTerritories() {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const rows = await db.getAllAsync<TerritoryRow>(
      "SELECT payload_json FROM territories ORDER BY created_at",
    );
    return rows.flatMap<Territory>((row) => {
      try {
        return [JSON.parse(row.payload_json) as Territory];
      } catch {
        return [];
      }
    });
  });
}

export function savePendingTerritory(
  record: Omit<PendingTerritoryRecord, "updatedAt">,
) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const updatedAt = Date.now();
    await db.runAsync(
      `INSERT OR REPLACE INTO pending_territories
       (id, session_id, raw_track_json, sensor_evidence_json,
        candidate_polygon_json, created_offline, status, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.sessionId,
      JSON.stringify(record.rawTrack),
      record.sensorEvidence ? JSON.stringify(record.sensorEvidence) : null,
      record.candidatePolygon ? JSON.stringify(record.candidatePolygon) : null,
      record.createdOffline ? 1 : 0,
      record.status,
      record.reason,
      record.createdAt,
      updatedAt,
    );
    if (record.status === "pending_validation") {
      await db.runAsync(
        `INSERT OR IGNORE INTO sync_queue
         (id, entity_type, entity_id, action, payload_json, status, attempts, created_at, updated_at)
         VALUES (?, 'tracking_session', ?, 'validate', ?, 'pending', 0, ?, ?)`,
        `validate-${record.sessionId}`,
        record.sessionId,
        JSON.stringify({ pendingTerritoryId: record.id }),
        record.createdAt,
        updatedAt,
      );
    }
  });
}

export function getPendingTerritories() {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const rows = await db.getAllAsync<PendingTerritoryRow>(
      "SELECT * FROM pending_territories WHERE status = 'pending_validation' ORDER BY created_at",
    );
    return rows.map<PendingTerritoryRecord>((row) => ({
      id: row.id,
      sessionId: row.session_id,
      rawTrack: JSON.parse(row.raw_track_json) as RawTrackPoint[],
      sensorEvidence: row.sensor_evidence_json
        ? (JSON.parse(row.sensor_evidence_json) as SensorEvidence)
        : null,
      candidatePolygon: row.candidate_polygon_json
        ? (JSON.parse(row.candidate_polygon_json) as GeoJsonPolygon)
        : null,
      createdOffline: row.created_offline === 1,
      status: row.status,
      reason: row.reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  });
}

export function resolvePendingTerritory(
  id: string,
  status: "confirmed" | "rejected",
) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const row = await db.getFirstAsync<{ session_id: string }>(
      "SELECT session_id FROM pending_territories WHERE id = ?",
      id,
    );
    await db.runAsync(
      "UPDATE pending_territories SET status = ?, updated_at = ? WHERE id = ?",
      status,
      Date.now(),
      id,
    );
    if (row) {
      await db.runAsync(
        `UPDATE sync_queue SET status = 'done', updated_at = ?
         WHERE entity_type = 'tracking_session' AND entity_id = ?`,
        Date.now(),
        row.session_id,
      );
      await db.runAsync(
        `UPDATE tracking_sessions SET status = 'synced', pending_road_match = 0
         WHERE id = ?`,
        row.session_id,
      );
    }
  });
}

export function saveRoadSegmentsToCache(segments: RoadSegment[]) {
  if (segments.length === 0) return Promise.resolve();
  return serializeOperation(async () => {
    const db = await openDatabase();
    const now = Date.now();
    await db.withExclusiveTransactionAsync(async (transaction) => {
      for (const segment of segments) {
        if (segment.coordinates.length < 2) continue;
        const latitudes = segment.coordinates.map((point) => point.latitude);
        const longitudes = segment.coordinates.map((point) => point.longitude);
        await transaction.runAsync(
          `INSERT INTO road_cache
           (id, segment_json, min_lat, max_lat, min_lon, max_lon, last_accessed, expires_at, pinned)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             segment_json = excluded.segment_json,
             min_lat = excluded.min_lat,
             max_lat = excluded.max_lat,
             min_lon = excluded.min_lon,
             max_lon = excluded.max_lon,
             last_accessed = excluded.last_accessed,
             expires_at = excluded.expires_at`,
          segment.id,
          JSON.stringify(segment),
          Math.min(...latitudes),
          Math.max(...latitudes),
          Math.min(...longitudes),
          Math.max(...longitudes),
          now,
          now + ROAD_CACHE_TTL_MS,
        );
      }
    });
    await pruneRoadCache(db, now);
  });
}

async function pruneRoadCache(db: SQLite.SQLiteDatabase, now = Date.now()) {
  await db.runAsync(
    "DELETE FROM road_cache WHERE pinned = 0 AND expires_at < ?",
    now,
  );
  await db.runAsync(
    `DELETE FROM road_cache WHERE id IN (
       SELECT id FROM road_cache WHERE pinned = 0
       ORDER BY last_accessed DESC LIMIT -1 OFFSET ?
     )`,
    ROAD_CACHE_MAX_SEGMENTS,
  );
}

export function getRoadSegmentsNearTrack(
  track: Array<{ latitude: number; longitude: number }>,
  paddingDegrees = 0.001,
) {
  if (track.length === 0) return Promise.resolve<RoadSegment[]>([]);
  return serializeOperation(async () => {
    const db = await openDatabase();
    const minLat = Math.min(...track.map((point) => point.latitude)) - paddingDegrees;
    const maxLat = Math.max(...track.map((point) => point.latitude)) + paddingDegrees;
    const minLon = Math.min(...track.map((point) => point.longitude)) - paddingDegrees;
    const maxLon = Math.max(...track.map((point) => point.longitude)) + paddingDegrees;
    const rows = await db.getAllAsync<{ id: string; segment_json: string }>(
      `SELECT id, segment_json FROM road_cache
       WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?
         AND (pinned = 1 OR expires_at >= ?)
       ORDER BY last_accessed DESC`,
      minLat,
      maxLat,
      minLon,
      maxLon,
      Date.now(),
    );
    if (rows.length > 0) {
      const accessedAt = Date.now();
      await db.runAsync(
        `UPDATE road_cache SET last_accessed = ?
         WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?`,
        accessedAt,
        minLat,
        maxLat,
        minLon,
        maxLon,
      );
    }
    return rows.flatMap<RoadSegment>((row) => {
      try {
        return [JSON.parse(row.segment_json) as RoadSegment];
      } catch {
        return [];
      }
    });
  });
}

export function saveTrustedServerTime(serverTime: number) {
  if (!Number.isFinite(serverTime)) return Promise.resolve();
  return serializeOperation(async () => {
    const db = await openDatabase();
    const previous = await db.getFirstAsync<TrustedTimeRow>(
      "SELECT server_time, monotonic_time, boot_id FROM trusted_time WHERE singleton = 1",
    );
    if (previous?.boot_id === bootId) {
      const estimated =
        previous.server_time + Math.max(0, monotonicNow() - previous.monotonic_time);
      if (Math.abs(serverTime - estimated) > 2 * 60 * 1_000) {
        await db.runAsync(
          `UPDATE tracking_sessions SET clock_anomaly = 1
           WHERE status IN ('active', 'pending_sync')`,
        );
      }
    }
    await db.runAsync(
      `INSERT OR REPLACE INTO trusted_time
       (singleton, server_time, monotonic_time, boot_id, updated_at)
       VALUES (1, ?, ?, ?, ?)`,
      serverTime,
      monotonicNow(),
      bootId,
      Date.now(),
    );
  });
}

export function getEstimatedTrustedTime() {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const row = await db.getFirstAsync<TrustedTimeRow>(
      "SELECT server_time, monotonic_time, boot_id FROM trusted_time WHERE singleton = 1",
    );
    if (!row) return null;
    if (row.boot_id !== bootId) return row.server_time;
    return row.server_time + Math.max(0, monotonicNow() - row.monotonic_time);
  });
}

export function verifySessionHashChain(sessionId: string) {
  return serializeOperation(async () => {
    const points = await getOfflineTrackingPointsDirect(sessionId);
    if (points.length === 0) return false;
    let previousHash = "";
    for (const point of points) {
      if (point.previousHash !== previousHash) return false;
      const expectedHash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        canonicalPointPayload({
          sessionId,
          sequence: point.sequence,
          point,
          wallClockTimestamp: point.wallClockTimestamp,
          monotonicTimestamp: point.monotonicTimestamp,
          sensorConfidence: point.sensorConfidence,
          createdOffline: point.createdOffline,
          previousHash,
          accepted: point.accepted,
        }),
      );
      if (expectedHash !== point.currentHash) return false;
      previousHash = point.currentHash;
    }
    return true;
  });
}

async function getOfflineTrackingPointsDirect(sessionId: string) {
  const db = await openDatabase();
  const rows = await db.getAllAsync<PointRow>(
    "SELECT * FROM tracking_points WHERE session_id = ? ORDER BY sequence",
    sessionId,
  );
  return rows.map<OfflineTrackingPoint>((row) => ({
    sessionId: row.session_id,
    sequence: row.sequence,
    latitude: row.latitude,
    longitude: row.longitude,
    accuracy: row.accuracy,
    speed: row.speed,
    heading: row.heading,
    timestamp: row.wall_clock_timestamp,
    wallClockTimestamp: row.wall_clock_timestamp,
    monotonicTimestamp: row.monotonic_timestamp,
    sensorConfidence: row.sensor_confidence,
    createdOffline: row.created_offline === 1,
    sensor: row.sensor_json ? JSON.parse(row.sensor_json) as SensorEvidence : undefined,
    previousHash: row.previous_hash,
    currentHash: row.current_hash,
    clockAnomaly: row.clock_anomaly === 1,
    accepted: row.accepted === 1,
  }));
}

export function getOfflineStorageStats() {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const counts = await Promise.all([
      db.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM tracking_sessions"),
      db.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM tracking_points"),
      db.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM territories"),
      db.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM pending_territories WHERE status = 'pending_validation'"),
      db.getFirstAsync<{ count: number; bytes: number }>("SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(segment_json)), 0) AS bytes FROM road_cache"),
      db.getFirstAsync<{ page_count: number }>("PRAGMA page_count"),
      db.getFirstAsync<{ page_size: number }>("PRAGMA page_size"),
    ]);
    return {
      trackingSessionsCount: counts[0]?.count ?? 0,
      trackingPointsCount: counts[1]?.count ?? 0,
      territoriesCount: counts[2]?.count ?? 0,
      pendingTerritoriesCount: counts[3]?.count ?? 0,
      roadCacheSize: counts[4]?.bytes ?? 0,
      localStorageUsed: (counts[5]?.page_count ?? 0) * (counts[6]?.page_size ?? 0),
    } satisfies OfflineStorageStats;
  });
}

export function clearRegenerableRoadCache() {
  return serializeOperation(async () => {
    const db = await openDatabase();
    await db.runAsync("DELETE FROM road_cache WHERE pinned = 0");
  });
}
