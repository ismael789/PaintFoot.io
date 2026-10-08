const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");
const home = read("src", "app", "index.tsx");
const storage = read("src", "services", "offline-storage.ts");
const sync = read("src", "services", "offline-sync.ts");
const simulation = read("src", "services", "offline-simulation-logic.ts");
const simulationScreen = read("src", "components", "offline-simulation-screen.tsx");

test("offline real 1: perder conexion cambia automaticamente el estado real", () => {
  assert.match(home, /NetInfo\.addEventListener/);
  assert.match(home, /isOnlineRef\.current = connected/);
  assert.match(home, /setIsOnline\(connected\)/);
  assert.match(sync, /Sin conexión · guardando recorrido local/);
});

test("offline real 2: iniciar sin Internet crea la sesion normal en SQLite", () => {
  assert.match(home, /beginStoredRouteSession\([\s\S]*?!isOnlineRef\.current/);
  assert.doesNotMatch(home.slice(home.indexOf("const startTracking"), home.indexOf("const stopTracking")), /startOfflineSimulation/);
  assert.match(storage, /INSERT INTO tracking_sessions/);
});

test("offline real 3: cada punto guarda sensores, secuencia, relojes, region y hash", () => {
  for (const expected of [
    "sensor_json",
    "sequence",
    "wall_clock_timestamp",
    "monotonic_timestamp",
    "boot_id",
    "region_id",
    "previous_hash",
    "current_hash",
  ]) assert.match(storage, new RegExp(expected));
  assert.match(storage, /action: "UPLOAD_TRACK"/);
});

test("offline real 4: cache completa valida local y queda pending_global_sync", () => {
  assert.match(home, /setActiveTrackingCacheCoverage/);
  assert.match(home, /cacheCoverageComplete[\s\S]*?"complete"/);
  assert.match(home, /"pending_global_sync"/);
  assert.match(storage, /cache_coverage TEXT NOT NULL DEFAULT 'unknown'/);
});

test("offline real 5: sin cache conserva el cierre como pending_validation", () => {
  assert.match(home, /detectProvisionalOfflineCandidate\(rawTrack\)/);
  assert.match(home, /status: "pending_validation"/);
  assert.match(home, /Perimetro cerrado pendiente de validacion vial/);
  assert.match(storage, /action: "VALIDATE_TERRITORY"/);
});

test("offline real 6: volver Internet procesa automaticamente la cola", () => {
  assert.match(sync, /NetInfo\.addEventListener/);
  assert.match(sync, /void synchronizePendingOperations\(\)/);
  assert.match(home, /await synchronizePendingOperations\(\)/);
  assert.match(sync, /Internet disponible · sincronizando/);
  assert.match(sync, /Sincronizado/);
});

test("offline real 7: funciona sin abrir simulacion y la prueba queda aislada", () => {
  assert.match(simulation, /paintfoot-offline-simulation\.db/);
  assert.match(simulationScreen, /Prueba visual de desarrollo/);
  assert.match(simulationScreen, /modo offline se activa automaticamente/);
  assert.doesNotMatch(home, /offline-simulation|OfflineSimulationScreen/);
});

test("offline real 8: robos pendientes usan confirmacion segura y respetan escudo", () => {
  assert.match(home, /"pending_capture"/);
  assert.match(sync, /\["pending_capture", "pending_global_sync"\]/);
  assert.match(sync, /confirmGlobalTerritoryCapture/);
  assert.match(sync, /Territorio protegido/);
  assert.match(sync, /resolveStoredGlobalCapture/);
});
