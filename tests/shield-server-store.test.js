const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ShieldServerStore } = require("../shield-server-store");

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paintfoot-shields-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new ShieldServerStore(path.join(directory, "state.json"));
}

test("prueba 14: una sesion de pago duplicada no da doble proteccion", (t) => {
  const store = temporaryStore(t);
  store.registerTerritory("territory-1", "player-1");
  const first = store.activate({
    territoryId: "territory-1", playerId: "player-1", durationHours: 6,
    source: "stripe", paymentId: "cs_test_duplicate", now: 1_000,
  });
  const duplicate = store.activate({
    territoryId: "territory-1", playerId: "player-1", durationHours: 6,
    source: "stripe", paymentId: "cs_test_duplicate", now: 5_000,
  });
  assert.deepEqual(duplicate, first);
  assert.equal(duplicate.expiresAt, 1_000 + 6 * 60 * 60 * 1_000);
});

test("prueba 16: el escudo gratis activa una hora sin Stripe", (t) => {
  const store = temporaryStore(t);
  store.registerTerritory("territory-1", "player-1");
  const result = store.claimFree("territory-1", "player-1", 1_000);
  assert.equal(result.shield.source, "free");
  assert.equal(result.shield.expiresAt, 1_000 + 60 * 60 * 1_000);
  assert.throws(
    () => store.claimFree("territory-1", "player-1", 2_000),
    /no se acumula/,
  );
});

test("prueba 17: el gratis no acumula y muestra cooldown de 24 horas", (t) => {
  const store = temporaryStore(t);
  store.registerTerritory("territory-1", "player-1");
  store.claimFree("territory-1", "player-1", 1_000);
  const afterExpiry = 2 * 60 * 60 * 1_000;
  assert.throws(() => store.claimFree("territory-1", "player-1", afterExpiry), /aun no esta disponible/);
  const status = store.getStatus("territory-1", "player-1", afterExpiry);
  assert.equal(status.free_available, false);
  assert.equal(status.free_available_at, 1_000 + 24 * 60 * 60 * 1_000);
});

test("la autoridad del servidor persiste el escudo al reiniciar", (t) => {
  const store = temporaryStore(t);
  store.registerTerritory("territory-1", "player-1");
  store.activate({
    territoryId: "territory-1", playerId: "player-1", durationHours: 1,
    source: "free", now: 1_000,
  });
  const restored = new ShieldServerStore(store.filePath);
  assert.equal(restored.getActiveShield("territory-1", 2_000)?.expiresAt, 1_000 + 60 * 60 * 1_000);
});

test("el estado global del escudo existe aunque el jugador tenga 0 territorios", (t) => {
  const store = temporaryStore(t);
  const status = store.getPlayerStatus("player-without-territories", 10_000);
  assert.equal(status.free_available, true);
  assert.equal(status.free_available_at, 0);
  assert.equal(status.free_last_claimed_at, null);
});
