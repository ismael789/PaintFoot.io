const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");
const profile = read("src", "app", "profile.tsx");
const home = read("src", "app", "index.tsx");
const sync = read("src", "services", "offline-sync.ts");
const envExample = read(".env.example");

test("visibilidad 1: Perfil normal no muestra la simulacion", () => {
  assert.match(profile, /\{OFFLINE_SIMULATION_ENABLED && \(/);
  assert.match(profile, /<Text style=\{styles\.simulationButtonTitle\}>Simulacion offline<\/Text>/);
});

test("visibilidad 2: Configuracion normal no expone acceso manual", () => {
  const guardIndex = profile.indexOf("{OFFLINE_SIMULATION_ENABLED && (");
  const accessIndex = profile.indexOf("onPress={() => setSimulationVisible(true)}");
  assert.ok(guardIndex >= 0 && accessIndex > guardIndex);
  assert.doesNotMatch(home, /setSimulationVisible|OfflineSimulationScreen/);
});

test("visibilidad 3: desarrollo con flag true habilita la herramienta", () => {
  assert.match(
    profile,
    /__DEV__ && process\.env\.EXPO_PUBLIC_ENABLE_OFFLINE_SIMULATION === "true"/,
  );
});

test("visibilidad 4: sin flag la configuracion de ejemplo permanece desactivada", () => {
  assert.match(envExample, /EXPO_PUBLIC_ENABLE_OFFLINE_SIMULATION=false/);
});

test("visibilidad 5: el offline real conserva deteccion automatica", () => {
  assert.match(home, /NetInfo\.addEventListener/);
  assert.match(home, /beginStoredRouteSession/);
  assert.match(home, /appendStoredRoutePoints/);
});

test("visibilidad 6: volver Internet conserva la sincronizacion automatica", () => {
  assert.match(sync, /NetInfo\.addEventListener/);
  assert.match(sync, /void synchronizePendingOperations\(\)/);
  assert.match(sync, /getPendingSyncOperations/);
});
