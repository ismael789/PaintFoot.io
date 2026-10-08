import assert from "node:assert/strict";
import test from "node:test";

import {
  canAttemptGlobalCapture,
  normalizeNearbyPlayers,
} from "../src/services/global-multiplayer-logic";
import type { NearbyPlayer, Territory } from "../src/types/game";

function territory(overrides: Partial<Territory> = {}): Territory {
  return {
    id: "territory-a",
    playerId: "owner-a",
    globalOwnerId: "owner-a",
    playerColor: "#E53935",
    color: "#E53935",
    owner: "Jugador A",
    polygon: { type: "Polygon", coordinates: [[]] },
    coordinates: [],
    areaM2: 300,
    createdAt: 1,
    signature: "same-world-shape",
    status: "confirmed",
    ...overrides,
  };
}

test("100 presencias regionales se deduplican sin perder jugadores", () => {
  const now = 100_000;
  const players: NearbyPlayer[] = Array.from({ length: 100 }, (_, index) => ({
    id: `player-${index}`,
    name: `Jugador ${index}`,
    color: `#${index.toString(16).padStart(6, "0")}`,
    latitude: 29,
    longitude: -110,
    accuracy: 5,
    heading: null,
    speed: null,
    regionId: "region_1_1",
    updatedAt: now,
  }));
  assert.equal(normalizeNearbyPlayers(players, "current", now).length, 100);
});

test("el mismo dueño conserva el mismo color para todos los clientes", () => {
  const firstClient = territory();
  const secondClient = { ...territory(), playerId: firstClient.playerId };
  assert.equal(firstClient.playerColor, secondClient.playerColor);
});

test("un territorio ajeno vulnerable requiere perimetro completo", () => {
  assert.equal(canAttemptGlobalCapture(territory(), "challenger", false, 2_000), false);
  assert.equal(canAttemptGlobalCapture(territory(), "challenger", true, 2_000), true);
});

test("un escudo activo bloquea el robo global", () => {
  const protectedTerritory = territory({
    shield: { startedAt: 1_000, expiresAt: 10_000, durationHours: 1 },
  });
  assert.equal(
    canAttemptGlobalCapture(protectedTerritory, "challenger", true, 2_000),
    false,
  );
  assert.equal(
    canAttemptGlobalCapture(
      territory({ status: "protected", shield: null }),
      "challenger",
      true,
      2_000,
    ),
    false,
  );
});

