const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");
const sql = read("supabase", "paintfoot-global-multiplayer.sql");
const service = read("src", "services", "global-multiplayer.ts");
const map = read("src", "services", "map-html.ts");
const home = read("src", "app", "index.tsx");
const profile = read("src", "app", "profile.tsx");

test("mundo global carga territorios paginados por regiones", () => {
  assert.match(service, /get_global_territories/);
  assert.match(service, /neighboringRoadRegionIds/);
  assert.match(service, /maximumTerritoryPages/);
  assert.match(sql, /region_ids && coalesce\(p_region_ids/);
});

test("perfil global asigna un color estable desde auth.uid", () => {
  assert.match(sql, /ensure_paintfoot_profile/);
  assert.match(sql, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(sql, /global_color/);
  assert.match(service, /applyGlobalPlayerProfile/);
});

test("presencia usa canales regionales, throttling y privacidad", () => {
  assert.match(service, /paintfoot-world:\$\{regionId\}/);
  assert.match(service, /presencePublishIntervalMs/);
  assert.match(service, /shareRealtimeLocation/);
  assert.match(service, /untrack\(\)/);
  assert.match(service, /get_nearby_player_presence/);
  assert.match(service, /activeTrail\.length \/ 24/);
  assert.match(map, /otherTrails/);
  assert.match(sql, /pp\.user_id <> auth\.uid\(\)/);
  assert.match(sql, /cleanup_stale_player_presence/);
});

test("captura global es RPC segura, idempotente y guarda historial", () => {
  assert.match(sql, /confirm_territory_capture/);
  assert.match(sql, /TERRITORY_PROTECTED/);
  assert.match(sql, /territory_ownership_history/);
  assert.match(sql, /territory_capture_disputes/);
  assert.match(sql, /operation_id text not null unique/);
  assert.match(sql, /revoke insert, update, delete on public\.territories/);
});

test("territorios confirmados conservan relleno y pendientes solo borde", () => {
  assert.match(map, /fillOpacity: pending \? 0 : \(disputed \? 0\.14 : 0\.30\)/);
  assert.match(map, /dashArray: pending/);
  assert.match(map, /fillColor: color \|\| '#208AEF'/);
});

test("la arquitectura principal usa exclusivamente el mundo global por regiones", () => {
  const closedGroup = "room";
  const forbidden = new RegExp(
    `(?:create|join|private)[_ -]?${closedGroup}|${closedGroup}[_ -]?id|lobby`,
    "i",
  );
  assert.doesNotMatch(service, forbidden);
  assert.doesNotMatch(sql, forbidden);
  assert.doesNotMatch(home, /crear sala|unirse a sala|c[oó]digo de sala/i);
  assert.doesNotMatch(profile, /crear sala|unirse a sala|c[oó]digo de sala/i);
  assert.match(service, /paintfoot-world:\$\{regionId\}/);
  assert.match(profile, /Multijugador global/);
});

test("los cambios globales se muestran como eventos del juego", () => {
  assert.match(home, /Territorio conquistado/);
  assert.match(home, /Territorio robado/);
  assert.match(home, /Territorio protegido/);
});

