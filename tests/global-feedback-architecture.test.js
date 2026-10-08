const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");
const home = read("src", "app", "index.tsx");
const profile = read("src", "app", "profile.tsx");
const layout = read("src", "app", "_layout.tsx");
const shield = read("src", "components", "territory-shield-panel.tsx");
const component = read("src", "components", "global-feedback.tsx");
const service = read("src", "services", "global-feedback.ts");
const sync = read("src", "services", "offline-sync.ts");

test("feedback global 1: perder Internet publica un mensaje no bloqueante", () => {
  assert.match(sync, /Sin conexión · guardando recorrido local/);
  assert.match(sync, /showFeedback/);
  assert.doesNotMatch(sync, /Alert\.alert/);
});

test("feedback global 2: reconexion actualiza el mismo evento hasta sincronizado", () => {
  assert.match(sync, /id: status === "offline" \|\| status === "syncing"/);
  assert.match(sync, /Internet disponible · sincronizando/);
  assert.match(sync, /Sincronizado/);
});

test("feedback global 3: una conquista confirmada muestra success", () => {
  assert.match(home, /message: "Territorio conquistado"/);
  assert.match(home, /type: "success"/);
});

test("feedback global 4: validacion pendiente muestra warning", () => {
  assert.match(home, /message: "Territorio pendiente de validación"/);
  assert.match(home, /id: "territory-validation"[\s\S]*?type: "warning"/);
});

test("feedback global 5: pago aprobado usa lenguaje del juego", () => {
  assert.match(shield, /message: "Pago aprobado"/);
  assert.doesNotMatch(component, /Stripe|PaymentIntent|Price ID|Webhook|RPC/);
});

test("feedback global 6: pago rechazado o cancelado es entendible", () => {
  assert.match(shield, /\? "Pago cancelado"[\s\S]*?: "No se pudo completar el pago"/);
  assert.match(shield, /normalized\.includes\("no se pudo completar el pago"\)/);
});

test("feedback global 7: cola y deduplicacion se centralizan por id", () => {
  assert.match(service, /current\?\.id === item\.id/);
  assert.match(service, /queue\.findIndex/);
  assert.match(service, /MAX_QUEUE_SIZE = 5/);
});

test("feedback global 8: la tarjeta flota sin bloquear controles", () => {
  assert.match(component, /pointerEvents="none"/);
  assert.match(component, /position: "absolute"/);
  assert.match(component, /top: insets\.top \+ 8/);
});

test("feedback global 9: Perfil, Pagos y mapa comparten el mismo sistema", () => {
  assert.match(profile, /showFeedback/);
  assert.match(shield, /showFeedback/);
  assert.match(home, /showFeedback/);
  assert.match(layout, /<GlobalFeedback \/>/);
});

test("feedback global 10: contraste, icono, etiqueta y tema son accesibles", () => {
  assert.match(component, /useColorScheme/);
  assert.match(component, /accessibilityLiveRegion="polite"/);
  assert.match(component, /accessibilityLabel/);
  for (const label of ["Información", "Completado", "Atención", "No completado"]) {
    assert.match(component, new RegExp(label));
  }
});
