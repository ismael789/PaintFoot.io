const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(...parts) {
  return fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");
}

const sql = read("supabase", "paintfoot-sync.sql");
const auth = read("src", "services", "auth.ts");
const sync = read("src", "services", "offline-sync.ts");
const offline = read("src", "services", "offline-storage.ts");
const clock = read("src", "services", "monotonic-clock.ts");
const regional = read("src", "services", "regional-road-cache.ts");
const nativeModule = read(
  "modules", "paintfoot-android-sensors", "android", "src", "main", "java",
  "expo", "modules", "paintfootandroidsensors", "PaintFootAndroidSensorsModule.kt",
);

test("auth: registro, login, logout y restauracion usan Supabase Auth", () => {
  assert.match(auth, /auth\.signUp/);
  assert.match(auth, /auth\.signInWithPassword/);
  assert.match(auth, /auth\.signOut/);
  assert.match(auth, /auth\.getSession/);
});

test("Supabase: RLS limita territorios, sesiones y puntos a auth.uid", () => {
  assert.match(sql, /enable row level security/gi);
  assert.match(sql, /auth\.uid\(\)\) = user_id/g);
  assert.match(sql, /territories_select_own/);
  assert.match(sql, /points_update_own/);
});

test("Supabase: RPC toma propietario de auth.uid y no recibe user_id", () => {
  const signature = sql.slice(sql.indexOf("sync_paintfoot_operation"), sql.indexOf(") returns jsonb"));
  assert.doesNotMatch(signature, /user_id/i);
  assert.match(sql, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(sql, /ENTITY_OWNED_BY_OTHER_USER/);
});

test("Supabase: operacion e IDs son idempotentes", () => {
  assert.match(sql, /operation_id text primary key/);
  assert.match(sql, /where id = p_entity_id/);
  assert.match(sql, /on conflict \(id\) do update/gi);
  assert.match(sync, /p_operation_id: operation\.id/);
});

test("sync: errores vuelven a pending con intentos y espera incremental", () => {
  assert.match(offline, /last_attempt_at/);
  assert.match(offline, /last_error/);
  assert.match(sync, /retryDelay/);
  assert.match(sync, /markSyncOperationPending/);
});

test("sync: recupera territorios sin producir un ciclo de subidas", () => {
  assert.match(sync, /get_paintfoot_snapshot/);
  assert.match(sync, /restoreStoredTerritoriesFromBackup/);
  assert.match(offline, /restoreOfflineTerritories/);
});

test("reloj: APK usa elapsedRealtime y Expo Go conserva fallback", () => {
  assert.match(nativeModule, /SystemClock\.elapsedRealtime\(\)/);
  assert.match(nativeModule, /Settings\.Global\.BOOT_COUNT/);
  assert.match(clock, /android_elapsed_realtime/);
  assert.match(clock, /js_monotonic_fallback/);
});

test("cache regional: usa region actual y vecinas con cobertura completa", () => {
  assert.match(regional, /neighboringRoadRegionIds/);
  assert.match(regional, /coverageStatus: "complete"/);
  assert.match(regional, /overpassEndpoint/);
  assert.match(offline, /coverage_status/);
});

test("cache regional: limites siguen centralizados en 200 MB y 500 regiones", () => {
  const config = read("src", "config", "offline.ts");
  assert.match(config, /maxBytes: 200 \* 1024 \* 1024/);
  assert.match(config, /maxRegions: 500/);
  assert.match(offline, /pinned_reason = 'territory'/);
  assert.match(offline, /pinned_reason = 'pending_validation'/);
});

test("seguridad: service_role no esta en codigo ejecutable de la app", () => {
  for (const relative of [
    ["src", "services", "supabase.ts"],
    ["src", "services", "offline-sync.ts"],
    ["src", "services", "auth.ts"],
  ]) {
    assert.doesNotMatch(read(...relative), /service_role/i);
  }
});

