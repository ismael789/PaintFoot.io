import assert from "node:assert/strict";
import test from "node:test";

import { MAX_SHIELD_DURATION_HOURS } from "../src/config/territory";
import {
  canPlayerConquerTerritory,
  canPlayerActivateShield,
  canApplyShieldDuration,
  createTerritoryShield,
  formatShieldRemainingTime,
  getFreeShieldAvailableAt,
  getShieldRemainingMs,
  getShieldVisualState,
  getPlayerShieldIndicator,
  isFreeShieldAvailable,
  isTerritoryShieldActive,
  isValidShieldDuration,
  isValidTerritoryShield,
  shouldActivateShieldForPayment,
  shouldOpenShieldOptions,
} from "../src/services/territory-shields";
import type { Territory } from "../src/types/game";

const HOUR_MS = 60 * 60 * 1_000;

function territoryWithShield(shield: Territory["shield"]): Territory {
  return {
    id: "territory-1", playerId: "owner", playerColor: "#00f",
    polygon: { type: "Polygon", coordinates: [[]] }, areaM2: 300,
    createdAt: 1, signature: "signature", coordinates: [], color: "#00f",
    owner: "Owner", shield,
  };
}

test("prueba 1: escudo recien activado usa el archivo visual activo", () => {
  const shield = createTerritoryShield(1, 0);
  assert.equal(getShieldVisualState(shield, 1), "active");
});

test("prueba 2: al entrar al 30 por ciento usa advertencia", () => {
  const shield = createTerritoryShield(1, 0);
  assert.equal(getShieldVisualState(shield, 42 * 60_000), "warning");
});

test("prueba 3: al llegar a cero usa agotado", () => {
  const shield = createTerritoryShield(1, 0);
  assert.equal(getShieldVisualState(shield, HOUR_MS), "exhausted");
});

test("el indicador siempre abre las opciones, incluso disponible, activo o agotado", () => {
  assert.equal(shouldOpenShieldOptions("available"), true);
  assert.equal(shouldOpenShieldOptions("exhausted"), true);
  assert.equal(shouldOpenShieldOptions("active"), true);
  assert.equal(shouldOpenShieldOptions("warning"), true);
});

test("pruebas 7, 8 y 9: solo un pago confirmado activa", () => {
  assert.equal(shouldActivateShieldForPayment("paid"), true);
  assert.equal(shouldActivateShieldForPayment("unpaid"), false);
  assert.equal(shouldActivateShieldForPayment("canceled"), false);
  assert.equal(shouldActivateShieldForPayment("failed"), false);
});

test("prueba 10: al reabrir se calcula el tiempo real restante", () => {
  const shield = createTerritoryShield(1, 1_000);
  assert.equal(getShieldRemainingMs(shield, 1_000 + 15 * 60_000), 45 * 60_000);
  assert.equal(formatShieldRemainingTime(45 * 60_000), "00:45:00");
});

test("prueba 11: si expiro con la app cerrada vuelve agotado", () => {
  const shield = createTerritoryShield(1, 1_000);
  assert.equal(getShieldVisualState(shield, 1_000 + HOUR_MS + 1), "exhausted");
});

test("pruebas 12 y 13: bloquea conquista protegida y permite tras expirar", () => {
  const shield = createTerritoryShield(1, 1_000);
  const territory = territoryWithShield(shield);
  assert.equal(canPlayerConquerTerritory(territory, "challenger", 2_000), false);
  assert.equal(canPlayerConquerTerritory(territory, "challenger", 1_000 + HOUR_MS), true);
});

test("pruebas 16 y 17: gratis inmediato y cooldown de 24 horas", () => {
  assert.equal(isFreeShieldAvailable(null, 10_000), true);
  assert.equal(isFreeShieldAvailable(10_000, 10_001), false);
  assert.equal(getFreeShieldAvailableAt(10_000), 10_000 + 24 * HOUR_MS);
  assert.equal(isFreeShieldAvailable(10_000, 10_000 + 24 * HOUR_MS), true);
});

test("arquitectura: admite duraciones de 1, 3, 6, 12, 24 y 36 horas", () => {
  for (const hours of [1, 3, 6, 12, 24, 36]) {
    assert.equal(isValidShieldDuration(hours), true);
  }
});

test("prueba 11: una duracion solicitada de 36 horas es valida", () => {
  const shield = createTerritoryShield(36, 1_000);
  assert.equal(MAX_SHIELD_DURATION_HOURS, 36);
  assert.equal(shield.durationHours, 36);
  assert.equal(shield.expiresAt, 1_000 + 36 * HOUR_MS);
  assert.equal(isValidTerritoryShield(shield), true);
});

test("prueba 12: una duracion solicitada de 37 horas es rechazada", () => {
  assert.equal(isValidShieldDuration(37), false);
  assert.throws(() => createTerritoryShield(37), RangeError);
});

test("prueba 13: una duracion solicitada de 72 horas es rechazada", () => {
  assert.equal(isValidShieldDuration(72), false);
  assert.throws(() => createTerritoryShield(72), RangeError);
});

test("no permite proteccion infinita, cero ni duraciones negativas", () => {
  for (const invalid of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
    assert.equal(isValidShieldDuration(invalid), false);
    assert.throws(() => createTerritoryShield(invalid), RangeError);
  }
});

test("renovar un escudo no puede superar 36 horas continuas", () => {
  const startedAt = 10_000;
  const current = createTerritoryShield(24, startedAt);
  const afterTwelveHours = startedAt + 12 * HOUR_MS;

  assert.throws(
    () => createTerritoryShield(36, afterTwelveHours, current),
    RangeError,
  );
  const maximumContinuous = createTerritoryShield(
    24,
    afterTwelveHours,
    current,
  );
  assert.equal(maximumContinuous.durationHours, 36);
  assert.equal(isTerritoryShieldActive(maximumContinuous, afterTwelveHours), true);
});

test("indicador global: con 0 territorios muestra escudo gratuito disponible", () => {
  const indicator = getPlayerShieldIndicator([], "owner", 0, 10_000);
  assert.equal(indicator.state, "available");
  assert.equal(indicator.activeTerritory, null);
  assert.equal(canPlayerActivateShield([], "owner"), false);
});

test("indicador global: con 0 territorios muestra agotado y su cooldown", () => {
  const indicator = getPlayerShieldIndicator([], "owner", 70_000, 10_000);
  assert.equal(indicator.state, "exhausted");
  assert.equal(indicator.freeCooldownRemainingMs, 60_000);
});

test("activar requiere un territorio del jugador y no uno ajeno", () => {
  const foreignTerritory = territoryWithShield(null);
  foreignTerritory.playerId = "another-player";
  assert.equal(canPlayerActivateShield([foreignTerritory], "owner"), false);

  const ownedTerritory = { ...foreignTerritory, playerId: "owner" };
  assert.equal(canPlayerActivateShield([ownedTerritory], "owner"), true);
});

test("indicador global muestra territorio activo y tiempo restante", () => {
  const territory = territoryWithShield(createTerritoryShield(1, 1_000));
  const indicator = getPlayerShieldIndicator([territory], "owner", 0, 2_000);
  assert.equal(indicator.state, "active");
  assert.equal(indicator.activeTerritory?.id, "territory-1");
  assert.equal(indicator.remainingMs, HOUR_MS - 1_000);
});

test("si desaparece el territorio activo el indicador global no falla", () => {
  const withTerritory = getPlayerShieldIndicator(
    [territoryWithShield(createTerritoryShield(1, 1_000))],
    "owner",
    0,
    2_000,
  );
  assert.equal(withTerritory.state, "active");

  const withoutTerritory = getPlayerShieldIndicator([], "owner", 0, 2_000);
  assert.equal(withoutTerritory.state, "available");
  assert.equal(withoutTerritory.activeTerritory, null);
});

test("Pagos respeta el máximo continuo de 36 horas antes de abrir Stripe", () => {
  const startedAt = 1_000;
  const shield = createTerritoryShield(24, startedAt);
  const afterTwelveHours = startedAt + 12 * HOUR_MS;
  assert.equal(canApplyShieldDuration(shield, 24, afterTwelveHours), true);
  assert.equal(canApplyShieldDuration(shield, 36, afterTwelveHours), false);
  assert.equal(canApplyShieldDuration(null, 36, afterTwelveHours), true);
  assert.equal(canApplyShieldDuration(null, 37, afterTwelveHours), false);
});
