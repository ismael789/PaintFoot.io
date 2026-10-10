const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const service = read("src/services/push-notifications.ts");
const profile = read("src/app/profile.tsx");
const layout = read("src/app/_layout.tsx");
const home = read("src/app/index.tsx");
const shield = read("src/components/territory-shield-panel.tsx");
const sync = read("src/services/offline-sync.ts");
const sql = read("supabase/paintfoot-push.sql");
const authServer = read("custom-auth-server.js");
const stripeApi = read("stripe-api.js");
const paymentPush = read("payment-push.js");
const mapHtml = read("src/services/map-html.ts");
const sensorMetrics = read("src/services/sensor-metrics.ts");
const app = JSON.parse(read("app.json"));

test("push 1: solicita permiso sin romper Expo Go", () => {
  assert.match(service, /requestNotificationPermission/);
  assert.match(service, /isExpoGoRuntime\(\).*expo-go-unsupported/s);
  assert.match(profile, /Notificaciones limitadas en Expo Go/);
});

test("push 2: crea los seis canales Android con nombres de juego", () => {
  for (const id of ["paintfoot-game", "paintfoot-shields", "paintfoot-sync", "paintfoot-coins", "paintfoot-territories", "paintfoot-payments"]) {
    assert.match(service, new RegExp(id));
  }
  assert.match(service, /configureNotificationChannels/);
});

test("push 3: Android declara POST_NOTIFICATIONS y plugin", () => {
  assert.ok(app.expo.android.permissions.includes("android.permission.POST_NOTIFICATIONS"));
  assert.ok(app.expo.plugins.some((plugin) => Array.isArray(plugin) && plugin[0] === "expo-notifications"));
});

test("push 4: token se registra en Supabase sin service role", () => {
  assert.match(service, /requestAuthenticatedPaintFootApi\("\/push\/register"/);
  assert.match(authServer, /from\("push_tokens"\)\.upsert/);
  assert.match(service, /getExpoPushTokenAsync/);
  assert.doesNotMatch(service, /service_role|SUPABASE_SECRET_KEY/);
});

test("push 5: SQL contiene tablas, RLS e idempotencia", () => {
  for (const table of ["push_tokens", "notification_preferences", "notification_log"]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(sql, /unique \(user_id, event_key\)/);
  assert.match(sql, /auth\.uid\(\)/);
});

test("push 6: escudos incluyen disponible, agotandose, agotado y protegido", () => {
  assert.match(service, /Escudo disponible/);
  assert.match(service, /Escudo por agotarse/);
  assert.match(service, /Escudo agotado/);
  assert.match(shield, /Territorio protegido/);
});

test("push 7: pagos se notifican solo despues de verificar", () => {
  assert.ok(
    stripeApi.indexOf('session.payment_status !== "paid"') <
      stripeApi.lastIndexOf("sendPaymentApprovedPush({"),
  );
  assert.match(paymentPush, /title: "Pago aprobado"/);
  assert.match(paymentPush, /body: "Tu protección fue activada\."/);
  assert.doesNotMatch(stripeApi, /const title = paid \? "Pago aprobado"/);
});

test("push 8: pago rechazado y cancelado no activan un escudo", () => {
  assert.match(stripeApi, /checkout\.session\.async_payment_failed/);
  assert.match(stripeApi, /status: "rejected"/);
  assert.match(stripeApi, /checkout\.session\.expired/);
  assert.match(stripeApi, /status: "canceled"/);
  assert.match(paymentPush, /Tu territorio no fue modificado/);
  assert.match(paymentPush, /No se realizó ningún cobro/);
});

test("push 9: territorios, monedas y sincronizacion tienen eventos agrupados", () => {
  assert.match(home, /territory_candidate:/);
  assert.match(home, /world_territory:/);
  assert.match(home, /coins_collected:/);
  assert.match(sync, /coins_synced:/);
  assert.match(sync, /sync_completed:/);
  assert.match(home, /coins_nearby:/);
});

test("push 10: preferencias cubren todas las categorias", () => {
  for (const category of ["shields", "territories", "coins", "sync", "world", "payments"]) {
    assert.match(profile, new RegExp(`\\["${category}"`));
  }
  assert.match(service, /saveNotificationPreferences/);
});

test("push 11: deduplicacion usa event keys persistentes", () => {
  assert.match(service, /shouldNotify/);
  assert.match(service, /EVENT_LOG_KEY/);
  assert.match(service, /EVENT_LOG_LIMIT/);
});

test("push 12: deep links cubren mapa, pago, escudo, territorio, monedas y sync", () => {
  for (const destination of ["paintfoot://shield", "paintfoot://payments", "paintfoot://map", "paintfoot://territory/", "paintfoot://coins", "paintfoot://sync"]) {
    assert.match(service, new RegExp(destination.replaceAll("/", "\\/")));
  }
  assert.match(layout, /subscribeToNotificationResponses/);
  assert.match(service, /getLastNotificationResponse/);
  assert.match(service, /addNotificationResponseReceivedListener/);
  assert.match(mapHtml, /window\.focusTerritory/);
  assert.match(home, /requestedTerritoryId/);
});

test("push 13: foreground conserva feedback y evita banners duplicados", () => {
  assert.match(service, /AppState\.currentState !== "active"/);
  assert.match(home, /showFeedback/);
  assert.match(shield, /showFeedback/);
});

test("push 14: el token pendiente se reintenta al recuperar Internet", () => {
  assert.match(service, /PENDING_TOKEN_KEY/);
  assert.match(service, /flushPendingPushRegistration/);
  assert.match(sync, /flushPendingPushRegistration/);
});

test("push 15: el agotamiento se programa para funcionar con la app cerrada", () => {
  assert.match(service, /shield_expired:/);
  assert.match(service, /SchedulableTriggerInputTypes\.DATE/);
  assert.match(service, /NOTIFICATION_CHANNELS\.shields/);
});

test("sensor 16: luz solo alterna claro y oscuro cuando Tema esta en Auto", () => {
  assert.match(sensorMetrics, /if \(preference !== "auto"\)/);
  assert.match(sensorMetrics, /detectProbablePocket/);
  assert.match(sensorMetrics, /lightConditionHoldMs/);
  assert.match(home, /if \(themePreference !== "auto"\)/);
  assert.match(home, /setAmbientLightEnabled\(false\)/);
});
