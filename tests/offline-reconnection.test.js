const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");
const home = read("src", "app", "index.tsx");
const storage = read("src", "services", "offline-storage.ts");
const background = read("src", "services", "background-location.ts");
const sync = read("src", "services", "offline-sync.ts");

const reconnectStart = home.indexOf("if (!isOnline) return;");
const reconnectEnd = home.indexOf("const scheduleRoadMatch", reconnectStart);
const reconnect = home.slice(reconnectStart, reconnectEnd);
const networkStart = home.indexOf("NetInfo.addEventListener");
const networkEnd = home.indexOf("return unsubscribe;", networkStart);
const network = home.slice(networkStart, networkEnd);

test("reconexion 1: volver Internet conserva el recorrido activo", () => {
  assert.match(network, /markStoredRouteConnectionState/);
  assert.doesNotMatch(network, /stopTracking|setIsTracking\(false\)/);
  assert.match(storage, /active_syncing/);
});

test("reconexion 2: el mismo sessionId se conserva en todos los estados activos", () => {
  assert.match(storage, /UPDATE tracking_sessions SET status = \?[\s\S]*WHERE id = \([\s\S]*SELECT id FROM tracking_sessions/);
  assert.doesNotMatch(reconnect, /beginStoredRouteSession|beginOfflineTrackingSession/);
});

test("reconexion 3: rawTrack y puntos offline no se limpian", () => {
  assert.doesNotMatch(reconnect, /rawTrackRef\.current\s*=\s*\[\]|clearStoredRoute/);
  assert.match(storage, /created_offline = MAX\(created_offline, \?\)/);
});

test("reconexion 4: GPS y sensores no se detienen al recuperar red", () => {
  assert.doesNotMatch(reconnect, /subscriptionRef\.current\.remove|stopSession|stopLocationUpdatesAsync/);
  assert.doesNotMatch(network, /subscriptionRef\.current\.remove|stopSession/);
});

test("reconexion 5: el Map Matching reutiliza el track online y offline completo", () => {
  assert.match(reconnect, /runRoadMatchRef\.current\(true\)/);
  assert.match(home, /const rawTrack = rawTrackRef\.current/);
  assert.match(home, /setRouteCoords\(nextTrack\)/);
});

test("reconexion 6: una validacion provisional no completa una sesion activa", () => {
  assert.match(home, /isActiveOfflineSessionStatus\(pendingSession\.status\)/);
  assert.match(storage, /status NOT IN[\s\S]*'active_local'[\s\S]*'active_offline'[\s\S]*'active_syncing'/);
});

test("reconexion 7: sync_queue respalda sin cortar la sesion activa", () => {
  assert.match(reconnect, /synchronizePendingOperations\(\)/);
  assert.match(sync, /getPendingSyncOperations\(\)/);
  assert.doesNotMatch(sync, /clearStoredRouteSession|setTrackingSessionStatus|beginStoredRouteSession/);
  assert.match(background, /markStoredRouteConnectionState/);
});

test("reconexion 8: el mapa mantiene la linea roja hasta detener", () => {
  assert.doesNotMatch(reconnect, /clearRoute|setRouteCoords\(\[\]\)/);
  assert.match(home, /window\.setRoute\(\$\{JSON\.stringify\(routeCoords\)\}\)/);
});
