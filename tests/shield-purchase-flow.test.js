const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("la compra vuelve a Expo Go o APK mediante el enlace propio de la ejecución", () => {
  const panel = read("src/components/territory-shield-panel.tsx");
  const api = read("stripe-api.js");
  assert.match(panel, /Linking\.createURL\("\/payments"\)/);
  assert.match(panel, /WebBrowser\.openAuthSessionAsync/);
  assert.match(api, /\["paintfootio:", "paintfoot:", "exp:", "exps:"\]/);
  assert.match(api, /location\.replace\(destination\)/);
});

test("todo pago verificado crea inventario con horas, importe y moneda", () => {
  const api = read("stripe-api.js");
  const store = read("shield-server-store.js");
  assert.match(api, /const purchasedShield = shieldServerStore\.storePurchasedShield/);
  assert.match(api, /amount: session\.amount_total/);
  assert.match(api, /currency: session\.currency/);
  assert.match(store, /amount: Number\.isInteger\(amount\)/);
  assert.match(store, /currency: typeof currency/);
});

test("Supabase conserva inventario e historial sin duplicar la sesión Stripe", () => {
  const sql = read("supabase/paintfoot-stripe.sql");
  const persistence = read("supabase-shield-purchases.js");
  assert.match(sql, /create table if not exists public\.paintfoot_shield_inventory/);
  assert.match(sql, /checkout_session_id text not null unique/);
  assert.match(sql, /unit_amount integer not null/);
  assert.match(persistence, /paintfoot_stripe_payments/);
  assert.match(persistence, /paintfoot_shield_inventory/);
  assert.match(persistence, /ignoreDuplicates: true/);
});

test("el historial y el inventario muestran duración y precio al jugador", () => {
  const panel = read("src/components/territory-shield-panel.tsx");
  assert.match(panel, /Valor: \{formatStoredPrice\(purchasedShield\.amount, purchasedShield\.currency\)\}/);
  assert.match(panel, /Importe: \{record\.amount/);
  assert.match(panel, /Protección de territorio · \{record\.durationHours\} h/);
});

test("el servidor envía push de pago aprobado solo después de verificar Stripe", () => {
  const api = read("stripe-api.js");
  const push = read("payment-push.js");
  const verificationIndex = api.indexOf("Stripe no confirmo el pago");
  const pushIndex = api.indexOf("sendPaymentApprovedPush({");
  assert.ok(verificationIndex >= 0 && pushIndex > verificationIndex);
  assert.match(push, /title: "Pago aprobado"/);
  assert.match(push, /Ya está en tu inventario/);
  assert.match(push, /notification_log/);
});
