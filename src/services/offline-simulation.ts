import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";

import {
  buildSimulationPointPayload,
  emptySimulationState,
  SIMULATION_DATABASE_NAME,
  SIMULATION_ROUTE,
  simulationCoordinateAt,
  type OfflineSimulationLog,
  type OfflineSimulationPoint,
  type OfflineSimulationState,
  type SimulationSyncStatus,
  type SimulationTerritoryStatus,
  type SimulationCenter,
} from "@/services/offline-simulation-logic";
import {
  getMonotonicSnapshot,
  initializeMonotonicClock,
} from "@/services/monotonic-clock";

interface StateRow {
  session_id: string;
  center_latitude: number | null;
  center_longitude: number | null;
  center_accuracy: number | null;
  forced_offline: number;
  route_active: number;
  cache_sufficient: number;
  territory_status: SimulationTerritoryStatus;
  sync_status: SimulationSyncStatus;
  started_at: number;
  updated_at: number;
}

interface PointRow {
  session_id: string;
  sequence: number;
  latitude: number;
  longitude: number;
  wall_clock_timestamp: number;
  monotonic_timestamp: number;
  monotonic_source: OfflineSimulationPoint["monotonicSource"];
  boot_id: string;
  previous_hash: string;
  current_hash: string;
}

interface LogRow {
  id: number;
  created_at: number;
  message: string;
  level: OfflineSimulationLog["level"];
}

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let operation = Promise.resolve<unknown>(undefined);

function serialize<T>(work: () => Promise<T>) {
  const next = operation.then(work, work);
  operation = next.then(() => undefined, () => undefined);
  return next;
}

async function openSimulationDatabase() {
  databasePromise ??= SQLite.openDatabaseAsync(SIMULATION_DATABASE_NAME).then(
    async (database) => {
      await database.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS simulation_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          session_id TEXT NOT NULL,
          center_latitude REAL,
          center_longitude REAL,
          center_accuracy REAL,
          forced_offline INTEGER NOT NULL,
          route_active INTEGER NOT NULL,
          cache_sufficient INTEGER NOT NULL,
          territory_status TEXT NOT NULL,
          sync_status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS simulation_points (
          session_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          wall_clock_timestamp INTEGER NOT NULL,
          monotonic_timestamp REAL NOT NULL,
          monotonic_source TEXT NOT NULL,
          boot_id TEXT NOT NULL,
          previous_hash TEXT NOT NULL,
          current_hash TEXT NOT NULL,
          PRIMARY KEY (session_id, sequence)
        );
        CREATE TABLE IF NOT EXISTS simulation_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          message TEXT NOT NULL,
          level TEXT NOT NULL
        );
      `);
      const stateColumns = await database.getAllAsync<{ name: string }>(
        "PRAGMA table_info(simulation_state)",
      );
      const columnNames = new Set(stateColumns.map((column) => column.name));
      if (!columnNames.has("center_latitude")) {
        await database.execAsync("ALTER TABLE simulation_state ADD COLUMN center_latitude REAL");
      }
      if (!columnNames.has("center_longitude")) {
        await database.execAsync("ALTER TABLE simulation_state ADD COLUMN center_longitude REAL");
      }
      if (!columnNames.has("center_accuracy")) {
        await database.execAsync("ALTER TABLE simulation_state ADD COLUMN center_accuracy REAL");
      }
      return database;
    },
  );
  return databasePromise;
}

async function addLog(
  database: SQLite.SQLiteDatabase,
  sessionId: string,
  message: string,
  level: OfflineSimulationLog["level"] = "completed",
) {
  await database.runAsync(
    `INSERT INTO simulation_logs (session_id, created_at, message, level)
     VALUES (?, ?, ?, ?)`,
    sessionId,
    Date.now(),
    message,
    level,
  );
}

async function readState(database: SQLite.SQLiteDatabase) {
  const row = await database.getFirstAsync<StateRow>(
    "SELECT * FROM simulation_state WHERE singleton = 1",
  );
  if (!row) return emptySimulationState();
  const pointRows = await database.getAllAsync<PointRow>(
    "SELECT * FROM simulation_points WHERE session_id = ? ORDER BY sequence",
    row.session_id,
  );
  const logRows = await database.getAllAsync<LogRow>(
    "SELECT id, created_at, message, level FROM simulation_logs WHERE session_id = ? ORDER BY id DESC LIMIT 60",
    row.session_id,
  );
  return {
    sessionId: row.session_id,
    centerLatitude: row.center_latitude,
    centerLongitude: row.center_longitude,
    centerAccuracy: row.center_accuracy,
    forcedOffline: row.forced_offline === 1,
    routeActive: row.route_active === 1,
    cacheSufficient: row.cache_sufficient === 1,
    territoryStatus: row.territory_status,
    syncStatus: row.sync_status,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    points: pointRows.map((point) => ({
      sessionId: point.session_id,
      sequence: point.sequence,
      latitude: point.latitude,
      longitude: point.longitude,
      wallClockTimestamp: point.wall_clock_timestamp,
      monotonicTimestamp: point.monotonic_timestamp,
      monotonicSource: point.monotonic_source,
      bootId: point.boot_id,
      previousHash: point.previous_hash,
      currentHash: point.current_hash,
    })),
    logs: logRows.map((log) => ({
      id: log.id,
      createdAt: log.created_at,
      message: log.message,
      level: log.level,
    })),
  } satisfies OfflineSimulationState;
}

export function loadOfflineSimulation() {
  return serialize(async () => readState(await openSimulationDatabase()));
}

export function startOfflineSimulation(center: SimulationCenter) {
  return serialize(async () => {
    await initializeMonotonicClock();
    const database = await openSimulationDatabase();
    const now = Date.now();
    const sessionId = `simulation-${now.toString(36)}`;
    await database.execAsync(
      "DELETE FROM simulation_points; DELETE FROM simulation_logs; DELETE FROM simulation_state;",
    );
    await database.runAsync(
      `INSERT INTO simulation_state
       (singleton, session_id, center_latitude, center_longitude, center_accuracy,
        forced_offline, route_active, cache_sufficient,
        territory_status, sync_status, started_at, updated_at)
       VALUES (1, ?, ?, ?, ?, 1, 1, 0, 'none', 'pending', ?, ?)`,
      sessionId,
      center.latitude,
      center.longitude,
      center.accuracy ?? null,
      now,
      now,
    );
    await addLog(database, sessionId, "Ubicacion actual obtenida para centrar la prueba");
    await addLog(database, sessionId, "Recorrido simulado iniciado sin Internet", "active");
    await addLog(database, sessionId, "Base SQLite aislada preparada");
    return readState(database);
  });
}

async function addPointDirect(
  database: SQLite.SQLiteDatabase,
  current: OfflineSimulationState,
) {
  if (!current.sessionId || !current.routeActive) {
    throw new Error("Inicia primero la simulacion sin Internet.");
  }
  if (current.points.length >= SIMULATION_ROUTE.length) {
    throw new Error("La ruta ya esta lista. Ahora simula el cierre del perimetro.");
  }
  const sequence = current.points.length + 1;
  const coordinate = simulationCoordinateAt(sequence, {
    latitude: current.centerLatitude ?? 29.07294,
    longitude: current.centerLongitude ?? -110.95592,
    accuracy: current.centerAccuracy,
  });
  const clock = getMonotonicSnapshot();
  const previousHash = current.points.at(-1)?.currentHash ?? "";
  const draft = {
    sequence,
    ...coordinate,
    wallClockTimestamp: Date.now(),
    monotonicTimestamp: clock.monotonicTimestamp,
    monotonicSource: clock.monotonicSource,
    bootId: clock.bootId,
    previousHash,
  };
  const currentHash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    buildSimulationPointPayload(current.sessionId, draft),
  );
  await database.runAsync(
    `INSERT INTO simulation_points
     (session_id, sequence, latitude, longitude, wall_clock_timestamp,
      monotonic_timestamp, monotonic_source, boot_id, previous_hash, current_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    current.sessionId,
    sequence,
    coordinate.latitude,
    coordinate.longitude,
    draft.wallClockTimestamp,
    draft.monotonicTimestamp,
    draft.monotonicSource,
    draft.bootId,
    previousHash,
    currentHash,
  );
  await database.runAsync(
    "UPDATE simulation_state SET updated_at = ? WHERE singleton = 1",
    Date.now(),
  );
  await addLog(database, current.sessionId, `Punto GPS #${sequence} guardado localmente`);
  await addLog(database, current.sessionId, `Hash actualizado: ${currentHash.slice(0, 8)}`);
}

export function addOfflineSimulationPoint() {
  return serialize(async () => {
    const database = await openSimulationDatabase();
    const current = await readState(database);
    await addPointDirect(database, current);
    return readState(database);
  });
}

export function setOfflineSimulationCache(sufficient: boolean) {
  return serialize(async () => {
    const database = await openSimulationDatabase();
    const current = await readState(database);
    if (!current.sessionId) return current;
    await database.runAsync(
      "UPDATE simulation_state SET cache_sufficient = ?, updated_at = ? WHERE singleton = 1",
      sufficient ? 1 : 0,
      Date.now(),
    );
    await addLog(
      database,
      current.sessionId,
      sufficient ? "Cache vial suficiente habilitada" : "Cache vial marcada como insuficiente",
      sufficient ? "completed" : "pending",
    );
    return readState(database);
  });
}

export function closeOfflineSimulationPerimeter() {
  return serialize(async () => {
    const database = await openSimulationDatabase();
    let current = await readState(database);
    if (!current.sessionId || !current.routeActive) {
      throw new Error("Inicia primero la simulacion sin Internet.");
    }
    const sessionId = current.sessionId;
    while (current.points.length < SIMULATION_ROUTE.length) {
      await addPointDirect(database, current);
      current = await readState(database);
    }
    const territoryStatus: SimulationTerritoryStatus = current.cacheSufficient
      ? "validated_offline"
      : "pending_validation";
    await database.runAsync(
      `UPDATE simulation_state
       SET route_active = 0, territory_status = ?, updated_at = ?
       WHERE singleton = 1`,
      territoryStatus,
      Date.now(),
    );
    await addLog(database, sessionId, "Perimetro simulado cerrado");
    await addLog(
      database,
      sessionId,
      current.cacheSufficient
        ? "Territorio validado con cache vial local"
        : "Sin cache vial suficiente: pending_validation",
      current.cacheSufficient ? "completed" : "pending",
    );
    return readState(database);
  });
}

export function restoreOfflineSimulationInternet() {
  return serialize(async () => {
    const database = await openSimulationDatabase();
    const current = await readState(database);
    if (!current.sessionId) throw new Error("No existe una simulacion activa.");
    await database.runAsync(
      `UPDATE simulation_state
       SET forced_offline = 0, sync_status = 'processing', updated_at = ?
       WHERE singleton = 1`,
      Date.now(),
    );
    await addLog(database, current.sessionId, "Internet simulado disponible");
    await addLog(database, current.sessionId, "Procesando sync_queue simulada", "active");
    await new Promise<void>((resolve) => setTimeout(resolve, 450));
    const territoryStatus: SimulationTerritoryStatus =
      current.territoryStatus === "pending_validation"
        ? "confirmed_simulation"
        : current.territoryStatus;
    await database.runAsync(
      `UPDATE simulation_state
       SET sync_status = 'completed', territory_status = ?, updated_at = ?
       WHERE singleton = 1`,
      territoryStatus,
      Date.now(),
    );
    await addLog(database, current.sessionId, "Sincronizacion simulada completada");
    return readState(database);
  });
}

export function resetOfflineSimulation() {
  return serialize(async () => {
    const database = await openSimulationDatabase();
    // This database contains simulation tables only. No real app table is opened.
    await database.execAsync(
      "DELETE FROM simulation_points; DELETE FROM simulation_logs; DELETE FROM simulation_state;",
    );
    return emptySimulationState();
  });
}

