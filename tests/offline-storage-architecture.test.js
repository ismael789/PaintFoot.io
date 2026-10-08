const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(...parts) {
  return fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");
}

const offlineStorage = read("src", "services", "offline-storage.ts");
const fileStorage = read("src", "services", "app-file-storage.ts");
const territoryStorage = read("src", "services", "territory-storage.ts");
const synchronization = read("src", "services", "offline-sync.ts");

test("offline storage: SQLite conserva datos importantes y referencias de cache", () => {
  assert.match(offlineStorage, /CREATE TABLE IF NOT EXISTS tracking_sessions/);
  assert.match(offlineStorage, /CREATE TABLE IF NOT EXISTS tracking_points/);
  assert.match(offlineStorage, /CREATE TABLE IF NOT EXISTS territories/);
  assert.match(offlineStorage, /CREATE TABLE IF NOT EXISTS sync_queue/);
  assert.match(offlineStorage, /CREATE TABLE IF NOT EXISTS road_cache_regions/);
  assert.doesNotMatch(offlineStorage, /INSERT INTO road_cache\s+\([^)]*segment_json/);
});

test("offline storage: archivos viales usan directorio app-specific y SHA-256", () => {
  assert.match(fileStorage, /Paths\.document/);
  assert.match(fileStorage, /ROAD_CACHE_DIRECTORY_NAME = "road-cache"/);
  assert.match(fileStorage, /Crypto\.CryptoDigestAlgorithm\.SHA256/);
  assert.doesNotMatch(fileStorage, /OBB|MANAGE_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE/);
});

test("offline storage: limpiar cache no elimina territorios ni recorridos", () => {
  const clearFunction = offlineStorage.slice(
    offlineStorage.indexOf("export function clearRegenerableRoadCache"),
  );
  assert.match(clearFunction, /DELETE FROM road_cache_regions/);
  assert.doesNotMatch(clearFunction, /DELETE FROM territories/);
  assert.doesNotMatch(clearFunction, /DELETE FROM tracking_sessions/);
  assert.doesNotMatch(clearFunction, /DELETE FROM tracking_points/);
});

test("offline storage: cola y RPC usan idempotencia sin confiar en userId del cliente", () => {
  assert.match(offlineStorage, /UNIQUE\(entity_type, entity_id, action\)/);
  assert.match(offlineStorage, /ON CONFLICT\(entity_type, entity_id, action\) DO UPDATE/);
  assert.match(synchronization, /p_operation_id: operation\.id/);
  assert.doesNotMatch(synchronization, /p_user_id|user_id: operation\.userId/);
});

test("offline storage: territorios se leen primero desde SQLite", () => {
  assert.match(territoryStorage, /getOfflineTerritories/);
  assert.doesNotMatch(territoryStorage, /supabase/);
});

test("offline storage: mantiene reloj monotono y cadena SHA-256", () => {
  assert.match(offlineStorage, /monotonicTimestamp/);
  assert.match(offlineStorage, /previousHash/);
  assert.match(offlineStorage, /currentHash/);
  assert.match(offlineStorage, /verifySessionHashChain/);
});

