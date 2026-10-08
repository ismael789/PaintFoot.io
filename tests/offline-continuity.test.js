const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");
const home = read("src", "app", "index.tsx");
const sync = read("src", "services", "offline-sync.ts");

const networkEffectStart = home.indexOf("NetInfo.addEventListener");
const networkEffectEnd = home.indexOf("return unsubscribe;", networkEffectStart);
const networkEffect = home.slice(networkEffectStart, networkEffectEnd);
const trackingStart = home.indexOf("const startTracking");
const trackingEnd = home.indexOf("const stopTracking", trackingStart);
const activeTracking = home.slice(trackingStart, trackingEnd);
const reconnectEffectStart = home.indexOf("if (!isOnline) return;");
const reconnectEffectEnd = home.indexOf("const scheduleRoadMatch", reconnectEffectStart);
const reconnectEffect = home.slice(reconnectEffectStart, reconnectEffectEnd);

test("continuidad 1: perder Internet no detiene el recorrido activo", () => {
  assert.match(networkEffect, /setIsOnline\(connected\)/);
  assert.doesNotMatch(networkEffect, /stopTracking|setIsTracking\(false\)|\.remove\(\)/);
});

test("continuidad 2: el cambio de red no navega fuera del mapa", () => {
  assert.doesNotMatch(networkEffect, /router\.|navigation\.|setSimulationVisible/);
});

test("continuidad 3: GPS y sensores no dependen del estado online", () => {
  assert.match(activeTracking, /motionSensorTrackerRef\.current\.start/);
  assert.match(activeTracking, /Location\.watchPositionAsync/);
  assert.doesNotMatch(activeTracking, /if \(!isOnlineRef\.current\) return/);
});

test("continuidad 4: cada punto cambia automaticamente a persistencia local", () => {
  assert.match(home, /appendStoredRoutePoints\([\s\S]*?!isOnlineRef\.current/);
  assert.match(sync, /Sin conexión · guardando recorrido local/);
});

test("continuidad 5: reconectar sincroniza sin reiniciar ruta o sesion", () => {
  assert.match(reconnectEffect, /synchronizePendingRoutes/);
  assert.match(reconnectEffect, /runRoadMatchRef\.current\(true\)/);
  assert.doesNotMatch(
    reconnectEffect,
    /clearStoredRouteSession|beginStoredRouteSession|setRawTrack|clearRoute|setIsTracking/,
  );
  assert.match(sync, /Internet disponible · sincronizando/);
  assert.match(sync, /Sincronizado/);
});

test("continuidad 6: perder o recuperar Internet no muestra alertas bloqueantes", () => {
  assert.doesNotMatch(networkEffect, /Alert\.alert|confirm|request/);
  assert.doesNotMatch(reconnectEffect, /Alert\.alert|confirm|request/);
});

test("continuidad 7: la sincronizacion se inicia sin accion manual", () => {
  assert.match(sync, /NetInfo\.addEventListener/);
  assert.match(sync, /void synchronizePendingOperations\(\)/);
  assert.doesNotMatch(sync, /Alert\.alert/);
});
