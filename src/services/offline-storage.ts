import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";

import { REGIONAL_CACHE_CONFIG } from "@/config/offline";
import {
  clearRoadCacheFiles,
  deleteRoadCacheBlock,
  getRoadCacheFilesSize,
  getAvailableStorageBytes,
  readRoadCacheBlock,
  readCoinRegionBlock,
  writeCoinRegionBlock,
  writeRoadCacheBlock,
} from "@/services/app-file-storage";
import {
  getMonotonicSnapshot,
  initializeMonotonicClock,
  type MonotonicSource,
} from "@/services/monotonic-clock";
import type {
  GeoJsonPolygon,
  RawTrackPoint,
  RoadSegment,
  SensorEvidence,
  Territory,
} from "@/types/game";
import type { WorldCoin } from "@/services/world-coins";

const DATABASE_NAME = "paintfoot-offline.db";
const DATABASE_VERSION = 7;
const ROAD_CACHE_TTL_MS = REGIONAL_CACHE_CONFIG.ttlMs;
const ROAD_CACHE_MAX_REGIONS = REGIONAL_CACHE_CONFIG.maxRegions;
const ROAD_CACHE_MAX_BYTES = REGIONAL_CACHE_CONFIG.maxBytes;
const CLOCK_BACKWARDS_TOLERANCE_MS = 5_000;
const CLOCK_DRIFT_TOLERANCE_MS = 2 * 60 * 1_000;

export type OfflineSessionStatus =
  | "active"
  | "active_local"
  | "active_offline"
  | "active_syncing"
  | "pending_sync"
  | "synced"
  | "completed";

export function isActiveOfflineSessionStatus(
  status: OfflineSessionStatus,
) {
  return ["active", "active_local", "active_offline", "active_syncing"].includes(
    status,
  );
}

export interface OfflineTrackingSession {
  id: string;
  playerId: string;
  startedAt: number;
  stoppedAt: number | null;
  pendingRoadMatch: boolean;
  status: OfflineSessionStatus;
  clockAnomaly: boolean;
  createdOffline: boolean;
  cacheCoverage: OfflineCacheCoverage;
}

export type OfflineCacheCoverage = "unknown" | "network" | "partial" | "complete";

export interface OfflineTrackingPoint extends RawTrackPoint {
  sessionId: string;
  sequence: number;
  wallClockTimestamp: number;
  monotonicTimestamp: number;
  monotonicSource: MonotonicSource;
  bootId: string;
  lastTrustedServerTime: number | null;
  estimatedTrustedTime: number | null;
  regionId: string;
  matchedOffline: boolean;
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
  territoriesSize: number;
  tracksSize: number;
  importantDataSize: number;
  totalSize: number;
  pendingSyncCount: number;
  roadCacheRegionCount: number;
}

export type SyncOperationAction =
  | "CREATE_TERRITORY"
  | "UPDATE_TERRITORY"
  | "CREATE_SESSION"
  | "UPDATE_SESSION"
  | "UPLOAD_TRACK"
  | "SYNC_STATS"
  | "VALIDATE_TERRITORY"
  | "COIN_COLLECTED"
  | "COIN_REGION_GENERATED"
  | "COIN_STATE_UPDATE";

export type StoredCoinStatus = "available" | "collected" | "expired";
export type StoredCoinSyncStatus = "local" | "pending_sync" | "synced";

export interface StoredCoin extends WorldCoin {
  status: StoredCoinStatus;
  createdAt: number;
  updatedAt: number;
  collectedAt: number | null;
  collectedBy: string | null;
  syncStatus: StoredCoinSyncStatus;
}

export interface CoinRegionMetadata {
  regionId: string;
  filePath: string;
  sizeBytes: number;
  contentHash: string;
  coinCount: number;
  updatedAt: number;
}

export interface SyncQueueOperation {
  id: string;
  userId: string;
  entityType: string;
  entityId: string;
  action: SyncOperationAction;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "done";
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastAttemptAt: number | null;
  lastError: string | null;
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
  last_monotonic: number | null;
  last_boot_id: string | null;
  monotonic_source: MonotonicSource | null;
  cache_coverage: OfflineCacheCoverage;
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
  monotonic_source: MonotonicSource;
  boot_id: string;
  last_trusted_server_time: number | null;
  estimated_trusted_time: number | null;
  region_id: string;
  matched_offline: number;
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

interface RoadCacheRegionRow {
  region_id: string;
  file_path: string;
  min_lat: number;
  max_lat: number;
  min_lon: number;
  max_lon: number;
  size_bytes: number;
  content_hash: string;
  created_at: number;
  updated_at: number;
  last_accessed: number;
  expires_at: number;
  pinned: number;
  pinned_reason: string | null;
  priority: number;
  coverage_status: "complete" | "partial" | "missing" | "stale";
  data_version: number;
}

interface SyncQueueRow {
  id: string;
  user_id: string;
  entity_type: string;
  entity_id: string;
  action: SyncOperationAction;
  payload_json: string;
  status: SyncQueueOperation["status"];
  attempts: number;
  created_at: number;
  updated_at: number;
  last_attempt_at: number | null;
  last_error: string | null;
}

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let operationQueue: Promise<void> = Promise.resolve();

export function monotonicNow() {
  return getMonotonicSnapshot().monotonicTimestamp;
}

export function coordinateRegionId(coordinate: {
  latitude: number;
  longitude: number;
}) {
  const latitudeCell = Math.floor(
    (coordinate.latitude + 90) / ROAD_REGION_DEGREES,
  );
  const longitudeCell = Math.floor(
    (coordinate.longitude + 180) / ROAD_REGION_DEGREES,
  );
  return `region_${latitudeCell}_${longitudeCell}`;
}

function serializeOperation<T>(operation: () => Promise<T>) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isSQLiteBusyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database is busy|SQLITE_BUSY/i.test(message);
}

async function retryIdempotentSQLiteWrite<T>(operation: () => Promise<T>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isSQLiteBusyError(error) || attempt === 3) throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 75 * (attempt + 1));
      });
    }
  }
  throw lastError;
}

const ROAD_REGION_DEGREES = REGIONAL_CACHE_CONFIG.regionDegrees;

export function roadRegionBoundsFromId(regionId: string) {
  const match = /^region_(\d+)_(\d+)$/.exec(regionId);
  if (!match) return null;
  const latitudeCell = Number(match[1]);
  const longitudeCell = Number(match[2]);
  const minLat = latitudeCell * ROAD_REGION_DEGREES - 90;
  const minLon = longitudeCell * ROAD_REGION_DEGREES - 180;
  return {
    minLat,
    maxLat: minLat + ROAD_REGION_DEGREES,
    minLon,
    maxLon: minLon + ROAD_REGION_DEGREES,
  };
}

export function neighboringRoadRegionIds(
  coordinate: { latitude: number; longitude: number },
  radius = REGIONAL_CACHE_CONFIG.neighborRadius,
) {
  const center = coordinateRegionId(coordinate);
  const match = /^region_(\d+)_(\d+)$/.exec(center);
  if (!match) return [center];
  const latitudeCell = Number(match[1]);
  const longitudeCell = Number(match[2]);
  const ids: string[] = [];
  for (let latitudeOffset = -radius; latitudeOffset <= radius; latitudeOffset += 1) {
    for (let longitudeOffset = -radius; longitudeOffset <= radius; longitudeOffset += 1) {
      ids.push(
        `region_${latitudeCell + latitudeOffset}_${longitudeCell + longitudeOffset}`,
      );
    }
  }
  return ids;
}

function roadRegionId(segment: RoadSegment) {
  const coordinate =
    segment.coordinates[Math.floor(segment.coordinates.length / 2)] ??
    segment.coordinates[0];
  return coordinate ? coordinateRegionId(coordinate) : "region_unknown";
}

function roadRegionBounds(segments: RoadSegment[]) {
  const coordinates = segments.flatMap((segment) => segment.coordinates);
  return {
    minLat: Math.min(...coordinates.map((point) => point.latitude)),
    maxLat: Math.max(...coordinates.map((point) => point.latitude)),
    minLon: Math.min(...coordinates.map((point) => point.longitude)),
    maxLon: Math.max(...coordinates.map((point) => point.longitude)),
  };
}

async function persistRoadRegion(
  db: SQLite.SQLiteDatabase,
  regionId: string,
  segments: RoadSegment[],
  pinned: boolean,
  now = Date.now(),
  coverageStatus: RoadCacheRegionRow["coverage_status"] = "partial",
  pinnedReason: string | null = null,
) {
  if (segments.length === 0) return;
  const bounds = roadRegionBoundsFromId(regionId) ?? roadRegionBounds(segments);
  const file = await writeRoadCacheBlock(regionId, segments);
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO road_cache_regions
       (region_id, file_path, min_lat, max_lat, min_lon, max_lon, size_bytes,
        content_hash, created_at, updated_at, last_accessed, expires_at, pinned,
        pinned_reason, priority, coverage_status, data_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(region_id) DO UPDATE SET
         file_path = excluded.file_path,
         min_lat = excluded.min_lat,
         max_lat = excluded.max_lat,
         min_lon = excluded.min_lon,
         max_lon = excluded.max_lon,
         size_bytes = excluded.size_bytes,
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at,
         last_accessed = excluded.last_accessed,
         expires_at = excluded.expires_at,
         pinned = MAX(road_cache_regions.pinned, excluded.pinned),
         pinned_reason = COALESCE(road_cache_regions.pinned_reason, excluded.pinned_reason),
         priority = MAX(road_cache_regions.priority, excluded.priority),
         coverage_status = excluded.coverage_status`,
      regionId,
      file.relativePath,
      bounds.minLat,
      bounds.maxLat,
      bounds.minLon,
      bounds.maxLon,
      file.sizeBytes,
      file.contentHash,
      now,
      now,
      now,
      now + ROAD_CACHE_TTL_MS,
      pinned ? 1 : 0,
      pinnedReason,
      pinned ? 100 : 10,
      coverageStatus,
    );
    await transaction.runAsync(
      "DELETE FROM road_cache_segment_index WHERE region_id = ?",
      regionId,
    );
    for (const segment of segments) {
      await transaction.runAsync(
        `INSERT OR REPLACE INTO road_cache_segment_index (segment_id, region_id)
         VALUES (?, ?)`,
        segment.id,
        regionId,
      );
    }
  });
}

async function migrateLegacyRoadCache(db: SQLite.SQLiteDatabase) {
  const legacyRows = await db.getAllAsync<{
    id: string;
    segment_json: string;
    pinned: number;
  }>("SELECT id, segment_json, pinned FROM road_cache WHERE segment_json <> ''");
  if (legacyRows.length === 0) return;

  const regions = new Map<
    string,
    { segments: Map<string, RoadSegment>; pinned: boolean; legacyIds: string[] }
  >();
  for (const row of legacyRows) {
    try {
      const segment = JSON.parse(row.segment_json) as RoadSegment;
      const regionId = roadRegionId(segment);
      const region = regions.get(regionId) ?? {
        segments: new Map<string, RoadSegment>(),
        pinned: false,
        legacyIds: [],
      };
      region.segments.set(segment.id, segment);
      region.pinned ||= row.pinned === 1;
      region.legacyIds.push(row.id);
      regions.set(regionId, region);
    } catch {
      // La cache es regenerable; una fila antigua dañada se descarta abajo.
    }
  }

  for (const [regionId, region] of regions) {
    await persistRoadRegion(
      db,
      regionId,
      [...region.segments.values()],
      region.pinned,
    );
  }
  await db.runAsync("DELETE FROM road_cache");
}

async function getRequiredRoadRegionPin(
  db: SQLite.SQLiteDatabase,
  regionId: string,
): Promise<{ pinned: boolean; reason: string | null }> {
  const territoryRows = await db.getAllAsync<{ payload_json: string }>(
    "SELECT payload_json FROM territories",
  );
  for (const row of territoryRows) {
    try {
      const territory = JSON.parse(row.payload_json) as Territory;
      if (territory.coordinates.some((point) => coordinateRegionId(point) === regionId)) {
        return { pinned: true, reason: "territory" };
      }
    } catch {
      // Una copia daÃ±ada no debe impedir regenerar mapas.
    }
  }
  const pendingRows = await db.getAllAsync<{ raw_track_json: string }>(
    `SELECT raw_track_json FROM pending_territories
     WHERE status = 'pending_validation'`,
  );
  for (const row of pendingRows) {
    try {
      const track = JSON.parse(row.raw_track_json) as RawTrackPoint[];
      if (track.some((point) => coordinateRegionId(point) === regionId)) {
        return { pinned: true, reason: "pending_validation" };
      }
    } catch {
      // Se conserva el resto de la cache aunque un pendiente estÃ© daÃ±ado.
    }
  }
  return { pinned: false, reason: null };
}

async function openDatabase() {
  if (!databasePromise) {
    databasePromise = initializeMonotonicClock()
      .then(() => SQLite.openDatabaseAsync(DATABASE_NAME))
      .then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 10000;
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
          last_wall_clock INTEGER,
          last_monotonic REAL,
          last_boot_id TEXT,
          monotonic_source TEXT,
          cache_coverage TEXT NOT NULL DEFAULT 'unknown'
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
          monotonic_source TEXT NOT NULL DEFAULT 'js_monotonic_fallback',
          boot_id TEXT NOT NULL DEFAULT 'legacy',
          last_trusted_server_time INTEGER,
          estimated_trusted_time INTEGER,
          region_id TEXT NOT NULL DEFAULT 'region_unknown',
          matched_offline INTEGER NOT NULL DEFAULT 0,
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
          monotonic_source TEXT NOT NULL DEFAULT 'js_monotonic_fallback',
          boot_id TEXT NOT NULL DEFAULT 'legacy',
          estimated_trusted_time INTEGER,
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
        CREATE TABLE IF NOT EXISTS road_cache_regions (
          region_id TEXT PRIMARY KEY NOT NULL,
          file_path TEXT NOT NULL,
          min_lat REAL NOT NULL,
          max_lat REAL NOT NULL,
          min_lon REAL NOT NULL,
          max_lon REAL NOT NULL,
          size_bytes INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0,
          last_accessed INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          pinned_reason TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          coverage_status TEXT NOT NULL DEFAULT 'partial',
          data_version INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_road_cache_regions_bounds
          ON road_cache_regions(min_lat, max_lat, min_lon, max_lon);
        CREATE TABLE IF NOT EXISTS road_cache_segment_index (
          segment_id TEXT PRIMARY KEY NOT NULL,
          region_id TEXT NOT NULL,
          FOREIGN KEY (region_id) REFERENCES road_cache_regions(region_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_road_cache_segment_region
          ON road_cache_segment_index(region_id);
        CREATE TABLE IF NOT EXISTS sync_queue (
          id TEXT PRIMARY KEY NOT NULL,
          user_id TEXT NOT NULL DEFAULT '',
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          action TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          last_attempt_at INTEGER,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(entity_type, entity_id, action)
        );
        CREATE TABLE IF NOT EXISTS coin_regions (
          region_id TEXT PRIMARY KEY NOT NULL,
          file_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          coin_count INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS coins (
          id TEXT PRIMARY KEY NOT NULL,
          region_id TEXT NOT NULL,
          road_segment_id TEXT NOT NULL,
          segment_index INTEGER NOT NULL,
          density_version INTEGER NOT NULL DEFAULT 1,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          value INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'available',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          collected_at INTEGER,
          collected_by TEXT,
          source TEXT NOT NULL DEFAULT 'osm_road',
          content_hash TEXT NOT NULL,
          sync_status TEXT NOT NULL DEFAULT 'local',
          FOREIGN KEY (region_id) REFERENCES coin_regions(region_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_coins_region_status
          ON coins(region_id, status);
        CREATE INDEX IF NOT EXISTS idx_coins_bounds_status
          ON coins(latitude, longitude, status);
        CREATE TABLE IF NOT EXISTS coin_balances (
          player_id TEXT PRIMARY KEY NOT NULL,
          balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
          updated_at INTEGER NOT NULL
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
      if ((version?.user_version ?? 0) < 3) {
        const syncColumns = await db.getAllAsync<{ name: string }>(
          "PRAGMA table_info(sync_queue)",
        );
        if (!syncColumns.some((column) => column.name === "user_id")) {
          await db.execAsync(
            "ALTER TABLE sync_queue ADD COLUMN user_id TEXT NOT NULL DEFAULT ''",
          );
        }
        await db.runAsync(
          "UPDATE sync_queue SET status = 'done', updated_at = ? WHERE action = 'validate'",
          Date.now(),
        );
      }
      if ((version?.user_version ?? 0) < 4) {
        const ensureColumn = async (
          table: string,
          name: string,
          definition: string,
        ) => {
          const columns = await db.getAllAsync<{ name: string }>(
            `PRAGMA table_info(${table})`,
          );
          if (!columns.some((column) => column.name === name)) {
            await db.execAsync(
              `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,
            );
          }
        };
        await ensureColumn("tracking_sessions", "last_monotonic", "REAL");
        await ensureColumn("tracking_sessions", "last_boot_id", "TEXT");
        await ensureColumn("tracking_sessions", "monotonic_source", "TEXT");
        await ensureColumn("tracking_points", "monotonic_source", "TEXT NOT NULL DEFAULT 'js_monotonic_fallback'");
        await ensureColumn("tracking_points", "boot_id", "TEXT NOT NULL DEFAULT 'legacy'");
        await ensureColumn("tracking_points", "last_trusted_server_time", "INTEGER");
        await ensureColumn("tracking_points", "estimated_trusted_time", "INTEGER");
        await ensureColumn("tracking_points", "region_id", "TEXT NOT NULL DEFAULT 'region_unknown'");
        await ensureColumn("tracking_points", "matched_offline", "INTEGER NOT NULL DEFAULT 0");
        await ensureColumn("sensor_events", "monotonic_source", "TEXT NOT NULL DEFAULT 'js_monotonic_fallback'");
        await ensureColumn("sensor_events", "boot_id", "TEXT NOT NULL DEFAULT 'legacy'");
        await ensureColumn("sensor_events", "estimated_trusted_time", "INTEGER");
        await ensureColumn("road_cache_regions", "created_at", "INTEGER NOT NULL DEFAULT 0");
        await ensureColumn("road_cache_regions", "updated_at", "INTEGER NOT NULL DEFAULT 0");
        await ensureColumn("road_cache_regions", "pinned_reason", "TEXT");
        await ensureColumn("road_cache_regions", "priority", "INTEGER NOT NULL DEFAULT 0");
        await ensureColumn("road_cache_regions", "coverage_status", "TEXT NOT NULL DEFAULT 'partial'");
        await ensureColumn("road_cache_regions", "data_version", "INTEGER NOT NULL DEFAULT 1");
        await ensureColumn("sync_queue", "last_attempt_at", "INTEGER");
        await ensureColumn("sync_queue", "last_error", "TEXT");
      }
      if ((version?.user_version ?? 0) < 5) {
        const sessionColumns = await db.getAllAsync<{ name: string }>(
          "PRAGMA table_info(tracking_sessions)",
        );
        if (!sessionColumns.some((column) => column.name === "cache_coverage")) {
          await db.execAsync(
            "ALTER TABLE tracking_sessions ADD COLUMN cache_coverage TEXT NOT NULL DEFAULT 'unknown'",
          );
        }
      }
      if ((version?.user_version ?? 0) < 7) {
        const coinColumns = await db.getAllAsync<{ name: string }>(
          "PRAGMA table_info(coins)",
        );
        if (!coinColumns.some((column) => column.name === "density_version")) {
          await db.execAsync(
            "ALTER TABLE coins ADD COLUMN density_version INTEGER NOT NULL DEFAULT 1",
          );
        }
      }
      if ((version?.user_version ?? 0) < DATABASE_VERSION) {
        await db.execAsync(`PRAGMA user_version = ${DATABASE_VERSION}`);
      }
      await db.runAsync(
        "UPDATE sync_queue SET status = 'pending' WHERE status = 'processing'",
      );
      await migrateLegacyRoadCache(db);
        return db;
      });
  }
  return databasePromise;
}

export async function initializeOfflineStorage() {
  await openDatabase();
}

const LOCAL_COIN_BALANCE_ID = "paintfoot-local-player";

function storedCoinFromRow(row: {
  id: string;
  region_id: string;
  road_segment_id: string;
  segment_index: number;
  density_version: number;
  latitude: number;
  longitude: number;
  value: number;
  status: StoredCoinStatus;
  created_at: number;
  updated_at: number;
  collected_at: number | null;
  collected_by: string | null;
  source: WorldCoin["source"];
  content_hash: string;
  sync_status: StoredCoinSyncStatus;
}): StoredCoin {
  return {
    id: row.id,
    regionId: row.region_id,
    roadSegmentId: row.road_segment_id,
    segmentIndex: row.segment_index,
    densityVersion: row.density_version ?? 1,
    latitude: row.latitude,
    longitude: row.longitude,
    value: row.value,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    collectedAt: row.collected_at,
    collectedBy: row.collected_by,
    source: row.source,
    hash: row.content_hash,
    syncStatus: row.sync_status,
  };
}

export async function saveCoinCatalogToStorage(
  coins: WorldCoin[],
  userId = "",
) {
  if (coins.length === 0) return;
  const grouped = new Map<string, WorldCoin[]>();
  for (const coin of coins) {
    const regional = grouped.get(coin.regionId) ?? [];
    regional.push(coin);
    grouped.set(coin.regionId, regional);
  }
  return serializeOperation(async () => {
    const db = await openDatabase();
    const now = Date.now();
    const files = new Map<string, Awaited<ReturnType<typeof writeCoinRegionBlock>>>();
    for (const [regionId, incoming] of grouped) {
      const previous = await db.getFirstAsync<{ content_hash: string }>(
        "SELECT content_hash FROM coin_regions WHERE region_id = ?",
        regionId,
      );
      const stored = previous
        ? await readCoinRegionBlock(regionId, previous.content_hash)
        : null;
      const merged = new Map((stored ?? []).map((coin) => [coin.id, coin]));
      incoming.forEach((coin) => merged.set(coin.id, coin));
      grouped.set(regionId, [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)));
      files.set(regionId, await writeCoinRegionBlock(regionId, grouped.get(regionId)!));
    }
    await retryIdempotentSQLiteWrite(() =>
      db.withExclusiveTransactionAsync(async (transaction) => {
        // Las posiciones disponibles son regenerables y viven en bloques por
        // región. SQLite conserva solo metadatos y cambios de estado, evitando
        // miles de escrituras que compitan con el GPS en segundo plano.
        for (const [regionId, regional] of grouped) {
          const file = files.get(regionId)!;
          await transaction.runAsync(
            `INSERT INTO coin_regions
             (region_id, file_path, size_bytes, content_hash, coin_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(region_id) DO UPDATE SET
               file_path = excluded.file_path,
               size_bytes = excluded.size_bytes,
               content_hash = excluded.content_hash,
               coin_count = excluded.coin_count,
               updated_at = excluded.updated_at`,
            regionId,
            file.relativePath,
            file.sizeBytes,
            file.contentHash,
            regional.length,
            now,
            now,
          );
          // Supabase valida lotes acotados. El hash del bloque vuelve cada lote
          // idempotente incluso si una region se completa en varias caminatas.
          for (let offset = 0; offset < regional.length; offset += 750) {
            const batchIndex = Math.floor(offset / 750);
            await enqueueSyncOperationDirect(transaction, {
              userId,
              entityType: "coin_region",
              entityId: `${regionId}:${file.contentHash}:${batchIndex}`,
              action: "COIN_REGION_GENERATED",
              payload: { regionId, coins: regional.slice(offset, offset + 750) },
              createdAt: now,
            });
          }
        }
      }),
    );
  });
}

export function getStoredCoinCatalog() {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const rows = await db.getAllAsync<any>("SELECT * FROM coins ORDER BY id");
    const storedStates = new Map(
      rows.map((row) => {
        const stored = storedCoinFromRow(row);
        return [stored.id, stored] as const;
      }),
    );
    const regions = await db.getAllAsync<{
      region_id: string;
      content_hash: string;
      updated_at: number;
    }>("SELECT region_id, content_hash, updated_at FROM coin_regions ORDER BY region_id");
    const catalog = new Map<string, StoredCoin>();
    for (const region of regions) {
      const fileCoins = await readCoinRegionBlock(region.region_id, region.content_hash);
      if (!fileCoins) continue;
      for (const coin of fileCoins) {
        const stored = storedStates.get(coin.id);
        catalog.set(coin.id, {
          ...coin,
          status: stored?.status ?? "available",
          createdAt: stored?.createdAt ?? region.updated_at,
          updatedAt: stored?.updatedAt ?? region.updated_at,
          collectedAt: stored?.collectedAt ?? null,
          collectedBy: stored?.collectedBy ?? null,
          syncStatus: stored?.syncStatus ?? "local",
        });
      }
    }
    return [...catalog.values()].sort((first, second) => first.id.localeCompare(second.id));
  });
}

/** Reads only the current/neighboring coin blocks instead of the whole city. */
export function getStoredCoinCatalogForRegions(regionIds: string[]) {
  return serializeOperation(async () => {
    if (regionIds.length === 0) return [] as StoredCoin[];
    const db = await openDatabase();
    const uniqueRegionIds = [...new Set(regionIds)];
    const placeholders = uniqueRegionIds.map(() => "?").join(",");
    const rows = await db.getAllAsync<any>("SELECT * FROM coins ORDER BY id");
    const storedStates = new Map(
      rows.map((row) => {
        const stored = storedCoinFromRow(row);
        return [stored.id, stored] as const;
      }),
    );
    const regions = await db.getAllAsync<{
      region_id: string;
      content_hash: string;
      updated_at: number;
    }>(
      `SELECT region_id, content_hash, updated_at FROM coin_regions
       WHERE region_id IN (${placeholders}) ORDER BY region_id`,
      ...uniqueRegionIds,
    );
    const catalog = new Map<string, StoredCoin>();
    for (const region of regions) {
      const fileCoins = await readCoinRegionBlock(region.region_id, region.content_hash);
      if (!fileCoins) continue;
      for (const coin of fileCoins) {
        const stored = storedStates.get(coin.id);
        catalog.set(coin.id, {
          ...coin,
          status: stored?.status ?? "available",
          createdAt: stored?.createdAt ?? region.updated_at,
          updatedAt: stored?.updatedAt ?? region.updated_at,
          collectedAt: stored?.collectedAt ?? null,
          collectedBy: stored?.collectedBy ?? null,
          syncStatus: stored?.syncStatus ?? "local",
        });
      }
    }
    return [...catalog.values()].sort((first, second) => first.id.localeCompare(second.id));
  });
}

export function filterStoredAvailableCoins<T extends { id: string }>(coins: T[]) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const unavailable = new Set(
      (await db.getAllAsync<{ id: string }>(
        "SELECT id FROM coins WHERE status <> 'available'",
      )).map((row) => row.id),
    );
    return coins.filter((coin) => !unavailable.has(coin.id));
  });
}

export function markStoredCoinsUnavailableGlobally(coinIds: string[]) {
  return serializeOperation(async () => {
    if (coinIds.length === 0) return;
    const db = await openDatabase();
    const now = Date.now();
    for (const coinId of coinIds) {
      await db.runAsync(
        `UPDATE coins SET status = 'collected', sync_status = 'synced',
         collected_by = COALESCE(collected_by, 'global-player'), updated_at = ?
         WHERE id = ? AND status = 'available'`,
        now, coinId,
      );
    }
  });
}

export function getStoredCoinBalance() {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const row = await db.getFirstAsync<{ balance: number }>(
      "SELECT balance FROM coin_balances WHERE player_id = ?",
      LOCAL_COIN_BALANCE_ID,
    );
    return row?.balance ?? 0;
  });
}

export function importLegacyCoinBalance(balance: number) {
  return serializeOperation(async () => {
    if (!Number.isInteger(balance) || balance <= 0) return;
    const db = await openDatabase();
    await db.runAsync(
      `INSERT INTO coin_balances(player_id, balance, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(player_id) DO NOTHING`,
      LOCAL_COIN_BALANCE_ID,
      balance,
      Date.now(),
    );
  });
}

export function importLegacyCollectedCoinIds(coinIds: string[]) {
  return serializeOperation(async () => {
    if (coinIds.length === 0) return;
    const db = await openDatabase();
    const now = Date.now();
    for (const coinId of coinIds.slice(-2_000)) {
      await db.runAsync(
        `UPDATE coins SET status = 'collected', sync_status = 'local', updated_at = ?
         WHERE id = ? AND status = 'available'`,
        now, coinId,
      );
    }
  });
}

export function spendStoredCoins(amount: number) {
  return serializeOperation(async () => {
    if (!Number.isInteger(amount) || amount <= 0) return false;
    const db = await openDatabase();
    const result = await db.runAsync(
      `UPDATE coin_balances SET balance = balance - ?, updated_at = ?
       WHERE player_id = ? AND balance >= ?`,
      amount,
      Date.now(),
      LOCAL_COIN_BALANCE_ID,
      amount,
    );
    return result.changes === 1;
  });
}

export function collectStoredCoin(coin: WorldCoin, collectedBy: string) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const now = Date.now();
    let collected = false;
    await db.withExclusiveTransactionAsync(async (transaction) => {
      const current = await transaction.getFirstAsync<{ status: StoredCoinStatus }>(
        "SELECT status FROM coins WHERE id = ?",
        coin.id,
      );
      if (current?.status === "collected") return;
      if (!current) {
        await transaction.runAsync(
          `INSERT OR IGNORE INTO coin_regions
           (region_id, file_path, size_bytes, content_hash, coin_count, created_at, updated_at)
           VALUES (?, '', 0, '', 1, ?, ?)`,
          coin.regionId, now, now,
        );
        await transaction.runAsync(
          `INSERT INTO coins
           (id, region_id, road_segment_id, segment_index, density_version, latitude, longitude,
            value, status, created_at, updated_at, source, content_hash, sync_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?, ?, 'local')`,
          coin.id, coin.regionId, coin.roadSegmentId, coin.segmentIndex,
          coin.densityVersion, coin.latitude, coin.longitude, coin.value,
          now, now, coin.source, coin.hash,
        );
      }
      await transaction.runAsync(
        `UPDATE coins SET status = 'collected', collected_at = ?, collected_by = ?,
         sync_status = 'pending_sync', updated_at = ? WHERE id = ?`,
        now, collectedBy, now, coin.id,
      );
      await transaction.runAsync(
        `INSERT INTO coin_balances(player_id, balance, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
           balance = coin_balances.balance + excluded.balance,
           updated_at = excluded.updated_at`,
        LOCAL_COIN_BALANCE_ID, Math.max(1, Math.floor(coin.value)), now,
      );
      await enqueueSyncOperationDirect(transaction, {
        userId: collectedBy,
        entityType: "coin",
        entityId: coin.id,
        action: "COIN_COLLECTED",
        payload: { coinId: coin.id, collectedAt: now },
        createdAt: now,
      });
      collected = true;
    });
    return collected;
  });
}

export function resolveStoredCoinCollection(
  coinId: string,
  awarded: boolean,
  authoritativeBalance?: number,
) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const now = Date.now();
    const coin = await db.getFirstAsync<{ value: number }>(
      "SELECT value FROM coins WHERE id = ?",
      coinId,
    );
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        "UPDATE coins SET sync_status = 'synced', updated_at = ? WHERE id = ?",
        now, coinId,
      );
      if (Number.isInteger(authoritativeBalance) && authoritativeBalance! >= 0) {
        await transaction.runAsync(
          `INSERT INTO coin_balances(player_id, balance, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(player_id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at`,
          LOCAL_COIN_BALANCE_ID, authoritativeBalance!, now,
        );
      } else if (!awarded && coin) {
        await transaction.runAsync(
          `UPDATE coin_balances SET balance = MAX(0, balance - ?), updated_at = ?
           WHERE player_id = ?`,
          coin.value, now, LOCAL_COIN_BALANCE_ID,
        );
      }
    });
  });
}

export function getCoinRegionMetadata() {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const rows = await db.getAllAsync<{
      region_id: string; file_path: string; size_bytes: number;
      content_hash: string; coin_count: number; updated_at: number;
    }>("SELECT * FROM coin_regions ORDER BY region_id");
    return rows.map((row) => ({
      regionId: row.region_id,
      filePath: row.file_path,
      sizeBytes: row.size_bytes,
      contentHash: row.content_hash,
      coinCount: row.coin_count,
      updatedAt: row.updated_at,
    } satisfies CoinRegionMetadata));
  });
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
    cacheCoverage: row.cache_coverage ?? "unknown",
  };
}

export function setActiveTrackingCacheCoverage(
  coverage: Exclude<OfflineCacheCoverage, "unknown">,
) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const session = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM tracking_sessions
       WHERE status IN ('active', 'active_local', 'active_offline', 'active_syncing', 'pending_sync')
       ORDER BY started_at DESC LIMIT 1`,
    );
    if (!session) return;
    await db.runAsync(
      "UPDATE tracking_sessions SET cache_coverage = ? WHERE id = ?",
      coverage,
      session.id,
    );
    if (coverage === "complete") {
      await db.runAsync(
        `UPDATE tracking_points SET matched_offline = 1
         WHERE session_id = ? AND created_offline = 1 AND accepted = 1`,
        session.id,
      );
    }
  });
}

async function enqueueSyncOperationDirect(
  db: SQLite.SQLiteDatabase,
  operation: {
    userId: string;
    entityType: string;
    entityId: string;
    action: SyncOperationAction;
    payload?: Record<string, unknown>;
    createdAt?: number;
  },
) {
  const createdAt = operation.createdAt ?? Date.now();
  const queuedAt = Date.now();
  const id = `${operation.action}:${operation.entityType}:${operation.entityId}:${queuedAt}`;
  await db.runAsync(
    `INSERT INTO sync_queue
     (id, user_id, entity_type, entity_id, action, payload_json, status,
      attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
     ON CONFLICT(entity_type, entity_id, action) DO UPDATE SET
       id = excluded.id,
       user_id = excluded.user_id,
       payload_json = excluded.payload_json,
       status = 'pending',
       attempts = 0,
       last_attempt_at = NULL,
       last_error = NULL,
       updated_at = excluded.updated_at`,
    id,
    operation.userId,
    operation.entityType,
    operation.entityId,
    operation.action,
    JSON.stringify(operation.payload ?? {}),
    queuedAt,
    createdAt,
  );
}

export function beginOfflineTrackingSession(
  playerId: string,
  startedAt = Date.now(),
  createdOffline = false,
) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const id = `route-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const clock = getMonotonicSnapshot();
    const status: OfflineSessionStatus = createdOffline
      ? "active_offline"
      : "active_local";
    await db.runAsync(
      `INSERT INTO tracking_sessions
       (id, player_id, started_at, stopped_at, pending_road_match, status,
        created_offline, last_wall_clock, last_monotonic, last_boot_id,
        monotonic_source)
       VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?)`,
      id,
      playerId,
      startedAt,
      status,
      createdOffline ? 1 : 0,
      startedAt,
      clock.monotonicTimestamp,
      clock.bootId,
      clock.monotonicSource,
    );
    await enqueueSyncOperationDirect(db, {
      userId: playerId,
      entityType: "tracking_session",
      entityId: id,
      action: "UPDATE_SESSION",
      payload: { sessionId: id },
      createdAt: startedAt,
    });
    return {
      id,
      playerId,
      startedAt,
      stoppedAt: null,
      pendingRoadMatch: false,
      status,
      clockAnomaly: false,
      createdOffline,
      cacheCoverage: "unknown" as const,
    };
  });
}

export function getRecoverableTrackingSession() {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const row = await db.getFirstAsync<SessionRow>(
      `SELECT * FROM tracking_sessions
       WHERE status IN ('active', 'active_local', 'active_offline', 'active_syncing', 'pending_sync')
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
       WHERE status IN ('active', 'active_local', 'active_offline', 'active_syncing', 'pending_sync')
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
    await enqueueSyncOperationDirect(db, {
      userId: session.player_id,
      entityType: "tracking_session",
      entityId: session.id,
      action: "UPDATE_SESSION",
      payload: { sessionId: session.id },
    });
  });
}

export function setActiveTrackingConnectionStatus(
  status: "active_local" | "active_offline" | "active_syncing",
) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    await db.runAsync(
      `UPDATE tracking_sessions SET status = ?
       WHERE id = (
         SELECT id FROM tracking_sessions
         WHERE status IN ('active', 'active_local', 'active_offline', 'active_syncing')
         ORDER BY started_at DESC LIMIT 1
       )`,
      status,
    );
  });
}

export function getTrackingSessionById(sessionId: string) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const row = await db.getFirstAsync<SessionRow>(
      "SELECT * FROM tracking_sessions WHERE id = ?",
      sessionId,
    );
    return row ? sessionFromRow(row) : null;
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
  monotonicSource: MonotonicSource;
  bootId: string;
  lastTrustedServerTime: number | null;
  estimatedTrustedTime: number | null;
  regionId: string;
  matchedOffline: boolean;
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
    monotonicSource: input.monotonicSource,
    bootId: input.bootId,
    lastTrustedServerTime: input.lastTrustedServerTime,
    estimatedTrustedTime: input.estimatedTrustedTime,
    regionId: input.regionId,
    matchedOffline: input.matchedOffline,
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
       WHERE status IN ('active', 'active_local', 'active_offline', 'active_syncing')
       ORDER BY started_at DESC LIMIT 1`,
    );
    if (!session) return [];

    let sequence = session.last_sequence;
    let previousHash = session.last_hash;
    let previousWallClock = session.last_wall_clock;
    let previousMonotonic = session.last_monotonic;
    let previousBootId = session.last_boot_id;
    let sessionClockAnomaly = session.clock_anomaly === 1;
    const stored: OfflineTrackingPoint[] = [];
    const trustedTime = await db.getFirstAsync<TrustedTimeRow>(
      "SELECT server_time, monotonic_time, boot_id FROM trusted_time WHERE singleton = 1",
    );

    await db.withExclusiveTransactionAsync(async (transaction) => {
      for (const point of points) {
        sequence += 1;
        const wallClockTimestamp = point.timestamp ?? Date.now();
        const clock = getMonotonicSnapshot();
        const monotonicTimestamp = clock.monotonicTimestamp;
        const sameBoot = previousBootId === null || previousBootId === clock.bootId;
        const estimatedTrustedTime =
          trustedTime?.boot_id === clock.bootId
            ? trustedTime.server_time +
              Math.max(0, monotonicTimestamp - trustedTime.monotonic_time)
            : null;
        const regionId = coordinateRegionId(point);
        const matchedOffline = Boolean(createdOffline && point.roadSegmentId);
        const sensorConfidence = confidenceFromSensor(point.sensor);
        const wallClockWentBack =
          previousWallClock !== null &&
          wallClockTimestamp + CLOCK_BACKWARDS_TOLERANCE_MS < previousWallClock;
        const deltaMismatch =
          sameBoot &&
          previousWallClock !== null &&
          previousMonotonic !== null &&
          Math.abs(
            (wallClockTimestamp - previousWallClock) -
              (monotonicTimestamp - previousMonotonic),
          ) > CLOCK_DRIFT_TOLERANCE_MS;
        const clockAnomaly = wallClockWentBack || deltaMismatch;
        sessionClockAnomaly ||= clockAnomaly;
        const currentHash = await Crypto.digestStringAsync(
          Crypto.CryptoDigestAlgorithm.SHA256,
          canonicalPointPayload({
            sessionId: session.id,
            sequence,
            point,
            wallClockTimestamp,
            monotonicTimestamp,
            monotonicSource: clock.monotonicSource,
            bootId: clock.bootId,
            lastTrustedServerTime: trustedTime?.server_time ?? null,
            estimatedTrustedTime,
            regionId,
            matchedOffline,
            sensorConfidence,
            createdOffline,
            previousHash,
            accepted: point.accepted !== false,
          }),
        );
        await transaction.runAsync(
          `INSERT OR IGNORE INTO tracking_points
           (session_id, sequence, latitude, longitude, accuracy, speed, heading,
            wall_clock_timestamp, monotonic_timestamp, monotonic_source, boot_id,
            last_trusted_server_time, estimated_trusted_time, region_id,
            matched_offline, sensor_confidence,
            created_offline, sensor_json, previous_hash, current_hash, clock_anomaly, accepted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          session.id,
          sequence,
          point.latitude,
          point.longitude,
          point.accuracy,
          point.speed ?? null,
          point.heading ?? null,
          wallClockTimestamp,
          monotonicTimestamp,
          clock.monotonicSource,
          clock.bootId,
          trustedTime?.server_time ?? null,
          estimatedTrustedTime,
          regionId,
          matchedOffline ? 1 : 0,
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
             (session_id, sequence, wall_clock_timestamp, monotonic_timestamp,
              monotonic_source, boot_id, estimated_trusted_time, payload_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            session.id,
            sequence,
            wallClockTimestamp,
            monotonicTimestamp,
            clock.monotonicSource,
            clock.bootId,
            estimatedTrustedTime,
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
          monotonicSource: clock.monotonicSource,
          bootId: clock.bootId,
          lastTrustedServerTime: trustedTime?.server_time ?? null,
          estimatedTrustedTime,
          regionId,
          matchedOffline,
          sensorConfidence,
          createdOffline,
          previousHash,
          currentHash,
          clockAnomaly,
          accepted: point.accepted !== false,
        });
        previousHash = currentHash;
        previousWallClock = wallClockTimestamp;
        previousMonotonic = monotonicTimestamp;
        previousBootId = clock.bootId;
      }
      await transaction.runAsync(
        `UPDATE tracking_sessions
         SET last_sequence = ?, last_hash = ?, last_wall_clock = ?,
             last_monotonic = ?, last_boot_id = ?, monotonic_source = ?,
             clock_anomaly = ?, created_offline = MAX(created_offline, ?)
         WHERE id = ?`,
        sequence,
        previousHash,
        previousWallClock,
        previousMonotonic,
        previousBootId,
        getMonotonicSnapshot().monotonicSource,
        sessionClockAnomaly ? 1 : 0,
        createdOffline ? 1 : 0,
        session.id,
      );
    });
    await enqueueSyncOperationDirect(db, {
      userId: session.player_id,
      entityType: "tracking_session",
      entityId: session.id,
      action: "UPLOAD_TRACK",
      payload: { sessionId: session.id, throughSequence: sequence },
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
           WHERE status IN ('active', 'active_local', 'active_offline', 'active_syncing', 'pending_sync')
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
      monotonicSource: row.monotonic_source,
      bootId: row.boot_id,
      lastTrustedServerTime: row.last_trusted_server_time,
      estimatedTrustedTime: row.estimated_trusted_time,
      regionId: row.region_id,
      matchedOffline: row.matched_offline === 1,
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
        const queuedAt = Date.now();
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
        await transaction.runAsync(
          `INSERT INTO sync_queue
           (id, user_id, entity_type, entity_id, action, payload_json, status,
            attempts, created_at, updated_at)
           VALUES (?, ?, 'territory', ?, 'CREATE_TERRITORY', ?, 'pending', 0, ?, ?)
           ON CONFLICT(entity_type, entity_id, action) DO UPDATE SET
             id = excluded.id,
             user_id = excluded.user_id,
             payload_json = excluded.payload_json,
             status = 'pending',
             attempts = 0,
             last_attempt_at = NULL,
             last_error = NULL,
             updated_at = excluded.updated_at`,
          `CREATE_TERRITORY:territory:${territory.id}:${queuedAt}`,
          territory.playerId,
          territory.id,
          JSON.stringify({ territoryId: territory.id }),
          territory.createdAt,
          queuedAt,
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
            `UPDATE road_cache_regions SET pinned = 1
             , pinned_reason = 'territory', priority = MAX(priority, 100)
             WHERE region_id = (
               SELECT region_id FROM road_cache_segment_index WHERE segment_id = ?
             )`,
            segmentId,
          );
        }
      }
    });
  });
}

/** Restaura copias del usuario autenticado sin crear otra operacion de subida. */
export function restoreOfflineTerritories(territories: Territory[]) {
  if (territories.length === 0) return Promise.resolve();
  return serializeOperation(async () => {
    const db = await openDatabase();
    await db.withExclusiveTransactionAsync(async (transaction) => {
      for (const territory of territories) {
        await transaction.runAsync(
          `INSERT INTO territories (id, signature, player_id, created_at, payload_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             signature = excluded.signature,
             player_id = excluded.player_id,
             created_at = excluded.created_at,
             payload_json = excluded.payload_json`,
          territory.id,
          territory.signature,
          territory.playerId,
          territory.createdAt,
          JSON.stringify(territory),
        );
      }
    });
  });
}

export function deleteOfflineTerritories(ids: string[]) {
  if (ids.length === 0) return Promise.resolve();
  return serializeOperation(async () => {
    const db = await openDatabase();
    const placeholders = ids.map(() => "?").join(",");
    await db.runAsync(
      `DELETE FROM territories WHERE id IN (${placeholders})`,
      ...ids,
    );
    await db.runAsync(
      `DELETE FROM sync_queue WHERE entity_type = 'territory'
       AND entity_id IN (${placeholders})`,
      ...ids,
    );
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
      const pendingRegionIds = [
        ...new Set(record.rawTrack.map(coordinateRegionId)),
      ];
      for (const regionId of pendingRegionIds) {
        await db.runAsync(
          `UPDATE road_cache_regions
           SET pinned = 1, pinned_reason = 'pending_validation',
               priority = MAX(priority, 90)
           WHERE region_id = ?`,
          regionId,
        );
      }
      const session = await db.getFirstAsync<{ player_id: string }>(
        "SELECT player_id FROM tracking_sessions WHERE id = ?",
        record.sessionId,
      );
      await enqueueSyncOperationDirect(db, {
        userId: session?.player_id ?? "",
        entityType: "pending_territory",
        entityId: record.id,
        action: "VALIDATE_TERRITORY",
        payload: { pendingTerritoryId: record.id, sessionId: record.sessionId },
        createdAt: record.createdAt,
      });
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
    const row = await db.getFirstAsync<{
      session_id: string;
      raw_track_json: string;
      session_status: OfflineSessionStatus;
    }>(
      `SELECT pending.session_id, pending.raw_track_json,
              session.status AS session_status
       FROM pending_territories AS pending
       JOIN tracking_sessions AS session ON session.id = pending.session_id
       WHERE pending.id = ?`,
      id,
    );
    if (!row || isActiveOfflineSessionStatus(row.session_status)) {
      return false;
    }
    await db.runAsync(
      "UPDATE pending_territories SET status = ?, updated_at = ? WHERE id = ?",
      status,
      Date.now(),
      id,
    );
    if (row) {
      try {
        const rawTrack = JSON.parse(row.raw_track_json) as RawTrackPoint[];
        for (const regionId of new Set(rawTrack.map(coordinateRegionId))) {
          await db.runAsync(
            `UPDATE road_cache_regions
             SET pinned = 0, pinned_reason = NULL, priority = 10
             WHERE region_id = ? AND pinned_reason = 'pending_validation'`,
            regionId,
          );
        }
      } catch {
        // La validacion ya termino; metadata de cache dañada no afecta el territorio.
      }
      await db.runAsync(
        `UPDATE sync_queue SET status = 'done', updated_at = ?
         WHERE entity_type = 'pending_territory' AND entity_id = ?
           AND action = 'VALIDATE_TERRITORY'`,
        Date.now(),
        id,
      );
      await db.runAsync(
        `UPDATE tracking_sessions SET status = 'completed', pending_road_match = 0
         WHERE id = ? AND status NOT IN
           ('active', 'active_local', 'active_offline', 'active_syncing')`,
        row.session_id,
      );
    }
    return true;
  });
}

export function saveRoadSegmentsToCache(
  segments: RoadSegment[],
  options?: {
    regionId?: string;
    coverageStatus?: RoadCacheRegionRow["coverage_status"];
    priority?: number;
  },
) {
  if (segments.length === 0) return Promise.resolve();
  return serializeOperation(async () => {
    const db = await openDatabase();
    const now = Date.now();
    const incomingRegions = new Map<string, RoadSegment[]>();
    for (const segment of segments) {
      if (segment.coordinates.length < 2) continue;
      const regionId = options?.regionId ?? roadRegionId(segment);
      const region = incomingRegions.get(regionId) ?? [];
      region.push(segment);
      incomingRegions.set(regionId, region);
    }
    for (const [regionId, incoming] of incomingRegions) {
      const existingRow = await db.getFirstAsync<RoadCacheRegionRow>(
        "SELECT * FROM road_cache_regions WHERE region_id = ?",
        regionId,
      );
      const existing = existingRow && options?.coverageStatus !== "complete"
        ? await readRoadCacheBlock(regionId, existingRow.content_hash)
        : null;
      const merged = new Map<string, RoadSegment>();
      for (const segment of existing ?? []) merged.set(segment.id, segment);
      for (const segment of incoming) merged.set(segment.id, segment);
      const requiredPin = existingRow?.pinned === 1
        ? { pinned: true, reason: existingRow.pinned_reason }
        : await getRequiredRoadRegionPin(db, regionId);
      await persistRoadRegion(
        db,
        regionId,
        [...merged.values()],
        requiredPin.pinned,
        now,
        options?.coverageStatus ?? existingRow?.coverage_status ?? "partial",
        requiredPin.reason,
      );
      if (options?.priority !== undefined) {
        await db.runAsync(
          "UPDATE road_cache_regions SET priority = MAX(priority, ?) WHERE region_id = ?",
          options.priority,
          regionId,
        );
      }
    }
    await pruneRoadCache(db, now);
  });
}

async function pruneRoadCache(db: SQLite.SQLiteDatabase, now = Date.now()) {
  const rows = await db.getAllAsync<RoadCacheRegionRow>(
    `SELECT * FROM road_cache_regions
     ORDER BY pinned DESC, priority DESC, last_accessed DESC`,
  );
  let retainedRegions = rows.length;
  let retainedBytes = rows.reduce((total, row) => total + row.size_bytes, 0);
  let lowStorage = getAvailableStorageBytes() < REGIONAL_CACHE_CONFIG.lowStorageThresholdBytes;
  for (const row of [...rows].reverse()) {
    const exceedsLimit =
      row.pinned === 0 &&
      (retainedRegions > ROAD_CACHE_MAX_REGIONS ||
        retainedBytes > ROAD_CACHE_MAX_BYTES ||
        (lowStorage && row.priority <= 10));
    if (!exceedsLimit) continue;
    deleteRoadCacheBlock(row.region_id);
    await db.runAsync(
      "DELETE FROM road_cache_regions WHERE region_id = ?",
      row.region_id,
    );
    retainedRegions -= 1;
    retainedBytes -= row.size_bytes;
    lowStorage = getAvailableStorageBytes() < REGIONAL_CACHE_CONFIG.lowStorageThresholdBytes;
  }
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
    const rows = await db.getAllAsync<RoadCacheRegionRow>(
      `SELECT * FROM road_cache_regions
       WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?
       ORDER BY last_accessed DESC`,
      minLat,
      maxLat,
      minLon,
      maxLon,
    );
    if (rows.length > 0) {
      const accessedAt = Date.now();
      await db.runAsync(
        `UPDATE road_cache_regions SET last_accessed = ?
         WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?`,
        accessedAt,
        minLat,
        maxLat,
        minLon,
        maxLon,
      );
    }
    const segments = new Map<string, RoadSegment>();
    for (const row of rows) {
      const block = await readRoadCacheBlock(row.region_id, row.content_hash);
      if (!block) {
        deleteRoadCacheBlock(row.region_id);
        await db.runAsync(
          "DELETE FROM road_cache_regions WHERE region_id = ?",
          row.region_id,
        );
        continue;
      }
      if (row.expires_at < Date.now() && row.coverage_status !== "stale") {
        await db.runAsync(
          "UPDATE road_cache_regions SET coverage_status = 'stale' WHERE region_id = ?",
          row.region_id,
        );
      }
      for (const segment of block) segments.set(segment.id, segment);
    }
    return [...segments.values()];
  });
}

export function getRoadCacheCoverage(
  track: Array<{ latitude: number; longitude: number }>,
) {
  return serializeOperation(async () => {
    if (track.length === 0) {
      return { sufficient: false, regionIds: [], missingRegionIds: [] };
    }
    const db = await openDatabase();
    const regionIds = [...new Set(track.map(coordinateRegionId))];
    const rows = await db.getAllAsync<{
      region_id: string;
      coverage_status: RoadCacheRegionRow["coverage_status"];
      expires_at: number;
    }>(
      `SELECT region_id, coverage_status, expires_at FROM road_cache_regions
       WHERE region_id IN (${regionIds.map(() => "?").join(",")})`,
      ...regionIds,
    );
    const statusByRegion = new Map(
      rows.map((row) => [
        row.region_id,
        row.expires_at < Date.now() ? "stale" : row.coverage_status,
      ]),
    );
    const missingRegionIds = regionIds.filter((regionId) => {
      const status = statusByRegion.get(regionId);
      return status !== "complete" && status !== "stale";
    });
    return {
      sufficient: missingRegionIds.length === 0,
      regionIds,
      missingRegionIds,
    };
  });
}

export function saveTrustedServerTime(serverTime: number) {
  if (!Number.isFinite(serverTime)) return Promise.resolve();
  return serializeOperation(async () => {
    const db = await openDatabase();
    const clock = getMonotonicSnapshot();
    const previous = await db.getFirstAsync<TrustedTimeRow>(
      "SELECT server_time, monotonic_time, boot_id FROM trusted_time WHERE singleton = 1",
    );
    if (previous?.boot_id === clock.bootId) {
      const estimated =
        previous.server_time +
        Math.max(0, clock.monotonicTimestamp - previous.monotonic_time);
      if (Math.abs(serverTime - estimated) > 2 * 60 * 1_000) {
        await db.runAsync(
          `UPDATE tracking_sessions SET clock_anomaly = 1
           WHERE status IN ('active', 'active_local', 'active_offline', 'active_syncing', 'pending_sync')`,
        );
      }
    }
    await db.runAsync(
      `INSERT OR REPLACE INTO trusted_time
       (singleton, server_time, monotonic_time, boot_id, updated_at)
       VALUES (1, ?, ?, ?, ?)`,
      serverTime,
      clock.monotonicTimestamp,
      clock.bootId,
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
    const clock = getMonotonicSnapshot();
    if (row.boot_id !== clock.bootId) return row.server_time;
    return (
      row.server_time +
      Math.max(0, clock.monotonicTimestamp - row.monotonic_time)
    );
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
          monotonicSource: point.monotonicSource,
          bootId: point.bootId,
          lastTrustedServerTime: point.lastTrustedServerTime,
          estimatedTrustedTime: point.estimatedTrustedTime,
          regionId: point.regionId,
          matchedOffline: point.matchedOffline,
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
    monotonicSource: row.monotonic_source,
    bootId: row.boot_id,
    lastTrustedServerTime: row.last_trusted_server_time,
    estimatedTrustedTime: row.estimated_trusted_time,
    regionId: row.region_id,
    matchedOffline: row.matched_offline === 1,
    sensorConfidence: row.sensor_confidence,
    createdOffline: row.created_offline === 1,
    sensor: row.sensor_json ? JSON.parse(row.sensor_json) as SensorEvidence : undefined,
    previousHash: row.previous_hash,
    currentHash: row.current_hash,
    clockAnomaly: row.clock_anomaly === 1,
    accepted: row.accepted === 1,
  }));
}

function syncOperationFromRow(row: SyncQueueRow): SyncQueueOperation {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    userId: row.user_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    payload,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAttemptAt: row.last_attempt_at,
    lastError: row.last_error,
  };
}

export function getPendingSyncOperations(limit = 25) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const rows = await db.getAllAsync<SyncQueueRow>(
      `SELECT * FROM sync_queue
       WHERE status = 'pending' AND action <> 'VALIDATE_TERRITORY'
       ORDER BY created_at, id LIMIT ?`,
      Math.max(1, Math.min(limit, 100)),
    );
    return rows.map(syncOperationFromRow);
  });
}

export function markSyncOperationProcessing(id: string) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    await db.runAsync(
      `UPDATE sync_queue
       SET status = 'processing', attempts = attempts + 1,
           last_attempt_at = ?, last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      Date.now(),
      Date.now(),
      id,
    );
  });
}

export function markSyncOperationPending(id: string, errorMessage?: string) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    await db.runAsync(
      `UPDATE sync_queue SET status = 'pending', last_error = ?, updated_at = ?
       WHERE id = ?`,
      errorMessage?.slice(0, 500) ?? null,
      Date.now(),
      id,
    );
  });
}

export function markSyncOperationDone(id: string) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    await db.runAsync(
      "UPDATE sync_queue SET status = 'done', updated_at = ? WHERE id = ?",
      Date.now(),
      id,
    );
  });
}

export function buildSyncOperationPayload(operation: SyncQueueOperation) {
  return serializeOperation(async () => {
    const db = await openDatabase();
    if (operation.entityType === "territory") {
      const territory = await db.getFirstAsync<{ payload_json: string }>(
        "SELECT payload_json FROM territories WHERE id = ?",
        operation.entityId,
      );
      return territory ? JSON.parse(territory.payload_json) : operation.payload;
    }
    if (operation.entityType === "tracking_session") {
      const session = await db.getFirstAsync<SessionRow>(
        "SELECT * FROM tracking_sessions WHERE id = ?",
        operation.entityId,
      );
      if (!session) return operation.payload;
      const points = await getOfflineTrackingPointsDirect(operation.entityId);
      return {
        session: sessionFromRow(session),
        points,
        integrity: {
          lastSequence: session.last_sequence,
          lastHash: session.last_hash,
          clockAnomaly: session.clock_anomaly === 1,
        },
      };
    }
    return operation.payload;
  });
}

export function getOfflineStorageStats() {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const counts = await Promise.all([
      db.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM tracking_sessions"),
      db.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM tracking_points"),
      db.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM territories"),
      db.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM pending_territories WHERE status = 'pending_validation'"),
      db.getFirstAsync<{ count: number; bytes: number }>("SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM road_cache_regions"),
      db.getFirstAsync<{ page_count: number }>("PRAGMA page_count"),
      db.getFirstAsync<{ page_size: number }>("PRAGMA page_size"),
      db.getFirstAsync<{ bytes: number }>("SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes FROM territories"),
      db.getFirstAsync<{ bytes: number }>(
        `SELECT
           (SELECT COUNT(*) * 160 FROM tracking_points) +
           (SELECT COALESCE(SUM(LENGTH(sensor_json)), 0) FROM tracking_points) +
           (SELECT COALESCE(SUM(LENGTH(raw_track_json) + LENGTH(COALESCE(sensor_evidence_json, ''))), 0) FROM pending_territories)
           AS bytes`,
      ),
      db.getFirstAsync<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_queue WHERE status <> 'done'",
      ),
    ]);
    const sqliteBytes =
      (counts[5]?.page_count ?? 0) * (counts[6]?.page_size ?? 0);
    const roadCacheBytes = Math.max(
      counts[4]?.bytes ?? 0,
      getRoadCacheFilesSize(),
    );
    const territoriesBytes = counts[7]?.bytes ?? 0;
    const tracksBytes = counts[8]?.bytes ?? 0;
    return {
      trackingSessionsCount: counts[0]?.count ?? 0,
      trackingPointsCount: counts[1]?.count ?? 0,
      territoriesCount: counts[2]?.count ?? 0,
      pendingTerritoriesCount: counts[3]?.count ?? 0,
      roadCacheSize: roadCacheBytes,
      localStorageUsed: sqliteBytes,
      territoriesSize: territoriesBytes,
      tracksSize: tracksBytes,
      importantDataSize: sqliteBytes,
      totalSize: sqliteBytes + roadCacheBytes,
      pendingSyncCount: counts[9]?.count ?? 0,
      roadCacheRegionCount: counts[4]?.count ?? 0,
    } satisfies OfflineStorageStats;
  });
}

export function clearRegenerableRoadCache() {
  return serializeOperation(async () => {
    const db = await openDatabase();
    const rows = await db.getAllAsync<{ region_id: string }>(
      "SELECT region_id FROM road_cache_regions WHERE pinned = 0",
    );
    for (const row of rows) deleteRoadCacheBlock(row.region_id);
    await db.runAsync("DELETE FROM road_cache_regions WHERE pinned = 0");
    await db.runAsync("DELETE FROM road_cache");
    if (
      (await db.getFirstAsync<{ count: number }>(
        "SELECT COUNT(*) AS count FROM road_cache_regions",
      ))?.count === 0
    ) {
      clearRoadCacheFiles();
    }
  });
}
