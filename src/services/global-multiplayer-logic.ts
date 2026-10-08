import { GLOBAL_MULTIPLAYER_RULES } from "../config/territory";
import { isTerritoryShieldActive } from "./territory-shields";
import type { NearbyPlayer, Territory } from "../types/game";

export function normalizeNearbyPlayers(
  entries: NearbyPlayer[],
  currentPlayerId: string,
  now = Date.now(),
) {
  const byId = new Map<string, NearbyPlayer>();
  for (const entry of entries) {
    if (
      entry.id === currentPlayerId ||
      now - entry.updatedAt > GLOBAL_MULTIPLAYER_RULES.presenceMaximumAgeMs
    ) continue;
    const previous = byId.get(entry.id);
    if (!previous || entry.updatedAt > previous.updatedAt) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

export function canAttemptGlobalCapture(
  territory: Territory,
  challengerId: string,
  hasCompleteCurrentPerimeter: boolean,
  now = Date.now(),
) {
  if (!hasCompleteCurrentPerimeter) return false;
  if (territory.playerId === challengerId) return false;
  if (territory.status === "protected") return false;
  return !isTerritoryShieldActive(territory.shield, now);
}

