const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const offlineStorage = read("src/services/offline-storage.ts");
const coinService = read("src/services/coins.ts");
const coinGenerator = read("src/services/world-coins.ts");
const fileStorage = read("src/services/app-file-storage.ts");
const offlineSync = read("src/services/offline-sync.ts");
const mapHtml = read("src/services/map-html.ts");
const home = read("src/app/index.tsx");
const sql = read("supabase/paintfoot-coins.sql");
const bundledSlrcRoads = JSON.parse(read("assets/data/slrc-walkable-roads.json"));

test("monedas 1: SQLite guarda posiciones, estado, recoleccion y sincronizacion", () => {
  assert.match(offlineStorage, /CREATE TABLE IF NOT EXISTS coins/);
  for (const column of [
    "region_id", "road_segment_id", "segment_index", "density_version", "latitude", "longitude",
    "status", "collected_at", "collected_by", "content_hash", "sync_status",
  ]) assert.match(offlineStorage, new RegExp(column));
  assert.match(offlineStorage, /CREATE TABLE IF NOT EXISTS coin_balances/);
  assert.match(offlineStorage, /PRAGMA busy_timeout = 10000/);
  assert.match(offlineStorage, /retryIdempotentSQLiteWrite/);
  assert.doesNotMatch(offlineStorage, /coinStatement\.executeAsync/);
  assert.doesNotMatch(offlineStorage, /coinStatement\.finalizeAsync/);
  assert.match(offlineStorage, /Las posiciones disponibles son regenerables/);
  assert.match(offlineStorage, /readCoinRegionBlock/);
  assert.match(coinService, /database is locked\|database is busy\|SQLITE_BUSY/);
});

test("monedas 2: IDs y procedencia vial son deterministas", () => {
  assert.match(coinGenerator, /roadSegmentId: segment\.id/);
  assert.match(coinGenerator, /segmentIndex:/);
  assert.match(coinGenerator, /source: "osm_road"/);
  assert.doesNotMatch(coinGenerator, /Math\.random|Date\.now/);
});

test("monedas 2b: la distribucion regional usa densidad version 7", () => {
  assert.match(coinGenerator, /COIN_DENSITY_VERSION = 7/);
  assert.match(coinGenerator, /COIN_MIN_PER_STREET = 5/);
  assert.match(coinGenerator, /COIN_SPAWN_INTERVAL_METERS = 20/);
  assert.match(coinGenerator, /COIN_MIN_DISTANCE_METERS = 15/);
  assert.match(home, /createRegionalStreetCoins/);
});

test("monedas 2c: San Luis carga monedas por radio y no toda la ciudad", () => {
  assert.match(coinGenerator, /COIN_LOAD_RADIUS_METERS = 800/);
  assert.match(coinGenerator, /COIN_UNLOAD_RADIUS_METERS = 1_200/);
  assert.match(coinGenerator, /COIN_RENDER_LIMIT = 50/);
  assert.doesNotMatch(home, /SAN_LUIS_RIO_COLORADO_COIN_TARGET/);
  assert.doesNotMatch(home, /SAN_LUIS_RIO_COLORADO_URBAN_BOUNDS/);
});

test("monedas 2d: la APK incluye calles reales de San Luis para uso offline", () => {
  assert.ok(bundledSlrcRoads.length >= 3_000);
  assert.ok(bundledSlrcRoads.every((segment) => segment.id.startsWith("osm-way-")));
  assert.ok(bundledSlrcRoads.every((segment) => segment.coordinates.length >= 2));
  assert.match(home, /getBundledSanLuisRioColoradoRoadSegmentsNear/);
});

test("monedas 3: archivos regionales usan almacenamiento app-specific y no OBB", () => {
  assert.match(fileStorage, /COIN_CACHE_DIRECTORY_NAME = "coins"/);
  assert.match(fileStorage, /writeCoinRegionBlock/);
  assert.match(fileStorage, /Paths\.document/);
  assert.match(offlineStorage, /CREATE TABLE IF NOT EXISTS coin_regions/);
  assert.doesNotMatch(fileStorage + offlineStorage + coinService, /\bOBB\b|\.obb/);
});

test("monedas 4: recoleccion offline es atomica y queda pending_sync", () => {
  assert.match(offlineStorage, /withExclusiveTransactionAsync/);
  assert.match(offlineStorage, /status = 'collected'/);
  assert.match(offlineStorage, /sync_status = 'pending_sync'/);
  assert.match(offlineStorage, /action: "COIN_COLLECTED"/);
  assert.match(coinService, /collectStoredCoin/);
});

test("monedas 5: reconexion sincroniza con RPC global idempotente", () => {
  assert.match(offlineSync, /operation\.action === "COIN_COLLECTED"/);
  assert.match(offlineSync, /collect_world_coin/);
  assert.match(offlineSync, /publish_world_coin_region/);
  assert.match(sql, /for update/);
  assert.match(sql, /operation_id text primary key/);
  assert.match(sql, /status = 'available'/);
});

test("monedas 6: SQLite es la fuente principal y AsyncStorage solo migra compatibilidad", () => {
  assert.match(coinService, /getStoredCoinCatalog/);
  assert.match(coinService, /saveCoinCatalogToStorage/);
  assert.match(coinService, /SQLITE_MIGRATION_KEY/);
  assert.match(home, /saveWorldCoinCatalog\(generated, myPlayerId\)/);
  assert.match(coinService, /getStoredWorldCoinCatalogNear/);
  assert.match(offlineStorage, /getStoredCoinCatalogForRegions/);
});

test("monedas 7: Leaflet renderiza solo el viewport util y evita el panel", () => {
  assert.match(mapHtml, /coinsInsideUsefulViewport/);
  assert.match(mapHtml, /bounds\.contains/);
  assert.match(mapHtml, /bottomViewportInset/);
  assert.match(mapHtml, /window\.setMapBottomInset/);
  assert.match(home, /window\.setMapBottomInset/);
  assert.match(mapHtml, /COIN_RENDER_LIMIT/);
  assert.match(mapHtml, /COIN_RENDER_RADIUS_METERS/);
  assert.match(mapHtml, /const visible = insideViewport/);
  assert.match(mapHtml, /limitCoinsAcrossRoads/);
  assert.match(mapHtml, /coin\.roadSegmentId/);
});

test("monedas 7b: las vias regionales se completan y persisten sin duplicados", () => {
  assert.match(coinGenerator, /createRegionalStreetCoins/);
  assert.match(coinGenerator, /COIN_MIN_PER_STREET/);
  assert.match(coinGenerator, /new Map<string, WorldCoin>/);
  assert.match(home, /loadRoadSegments/);
  assert.match(offlineStorage, /merged\.set\(coin\.id, coin\)/);
});

test("monedas 8: el saldo persistente se actualiza junto con la recoleccion", () => {
  assert.match(offlineStorage, /INSERT INTO coin_balances/);
  assert.match(offlineStorage, /balance = coin_balances\.balance \+ excluded\.balance/);
  assert.match(coinService, /getStoredCoinBalance/);
  assert.match(coinService, /publishBalance/);
});

