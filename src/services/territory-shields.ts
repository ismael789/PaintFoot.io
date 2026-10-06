import {
  MAX_SHIELD_DURATION_HOURS,
  SHIELD_RULES,
} from "../config/territory";
import type { Territory, TerritoryShield } from "../types/game";

const MAX_SHIELD_DURATION_MS =
  MAX_SHIELD_DURATION_HOURS * SHIELD_RULES.millisecondsPerHour;

export function isValidShieldDuration(durationHours: number) {
  return (
    Number.isFinite(durationHours) &&
    durationHours > 0 &&
    durationHours <= MAX_SHIELD_DURATION_HOURS
  );
}

export function isValidTerritoryShield(
  value: unknown,
): value is TerritoryShield {
  if (!value || typeof value !== "object") return false;
  const shield = value as Partial<TerritoryShield>;
  if (
    !isValidShieldDuration(shield.durationHours ?? Number.NaN) ||
    !Number.isFinite(shield.startedAt) ||
    !Number.isFinite(shield.expiresAt)
  ) {
    return false;
  }

  const protectedDurationMs = shield.expiresAt! - shield.startedAt!;
  return (
    protectedDurationMs > 0 &&
    protectedDurationMs <= MAX_SHIELD_DURATION_MS
  );
}

export function isTerritoryShieldActive(
  shield: TerritoryShield | null | undefined,
  now = Date.now(),
) {
  return Boolean(
    shield && isValidTerritoryShield(shield) && now < shield.expiresAt,
  );
}

export function createTerritoryShield(
  requestedDurationHours: number,
  now = Date.now(),
  currentShield?: TerritoryShield | null,
  metadata?: Pick<TerritoryShield, "source" | "paymentId">,
): TerritoryShield {
  if (!isValidShieldDuration(requestedDurationHours)) {
    throw new RangeError(
      `La duracion del escudo debe ser mayor que 0 y no superar ${MAX_SHIELD_DURATION_HOURS} horas.`,
    );
  }
  if (!Number.isFinite(now)) {
    throw new RangeError("La fecha de activacion del escudo no es valida.");
  }

  const currentIsActive = isTerritoryShieldActive(currentShield, now);
  const startedAt = currentIsActive ? currentShield!.startedAt : now;
  const expiresAt = now + requestedDurationHours * SHIELD_RULES.millisecondsPerHour;

  if (expiresAt - startedAt > MAX_SHIELD_DURATION_MS) {
    throw new RangeError(
      `La proteccion continua no puede superar ${MAX_SHIELD_DURATION_HOURS} horas.`,
    );
  }

  return {
    startedAt,
    expiresAt,
    durationHours: (expiresAt - startedAt) / SHIELD_RULES.millisecondsPerHour,
    source: metadata?.source,
    paymentId: metadata?.paymentId ?? null,
  };
}

export type ShieldVisualState = "active" | "warning" | "exhausted";

export type PlayerShieldIndicatorState =
  | "available"
  | "active"
  | "warning"
  | "exhausted";

export interface PlayerShieldIndicator {
  state: PlayerShieldIndicatorState;
  activeTerritory: Territory | null;
  remainingMs: number;
  freeCooldownRemainingMs: number;
}

export function getShieldRemainingMs(
  shield: TerritoryShield | null | undefined,
  now = Date.now(),
) {
  return isTerritoryShieldActive(shield, now)
    ? Math.max(0, shield!.expiresAt - now)
    : 0;
}

export function getShieldRemainingPercentage(
  shield: TerritoryShield | null | undefined,
  now = Date.now(),
) {
  if (!shield || !isValidTerritoryShield(shield)) return 0;
  const total = shield.expiresAt - shield.startedAt;
  return Math.min(1, getShieldRemainingMs(shield, now) / total);
}

export function getShieldVisualState(
  shield: TerritoryShield | null | undefined,
  now = Date.now(),
): ShieldVisualState {
  if (!isTerritoryShieldActive(shield, now)) return "exhausted";
  return getShieldRemainingPercentage(shield, now) <=
    SHIELD_RULES.warningPercentage
    ? "warning"
    : "active";
}

export function getPlayerShieldIndicator(
  territories: Territory[],
  playerId: string,
  freeAvailableAt: number,
  now = Date.now(),
): PlayerShieldIndicator {
  const activeTerritory = territories.find(
    (territory) =>
      territory.playerId === playerId &&
      isTerritoryShieldActive(territory.shield, now),
  ) ?? null;

  if (activeTerritory) {
    const state = getShieldVisualState(activeTerritory.shield, now);
    return {
      state,
      activeTerritory,
      remainingMs: getShieldRemainingMs(activeTerritory.shield, now),
      freeCooldownRemainingMs: Math.max(0, freeAvailableAt - now),
    };
  }

  const freeCooldownRemainingMs = Math.max(0, freeAvailableAt - now);
  return {
    state: freeCooldownRemainingMs === 0 ? "available" : "exhausted",
    activeTerritory: null,
    remainingMs: 0,
    freeCooldownRemainingMs,
  };
}

export function canPlayerActivateShield(
  territories: Territory[],
  playerId: string,
) {
  return territories.some((territory) => territory.playerId === playerId);
}

export function canApplyShieldDuration(
  shield: TerritoryShield | null | undefined,
  requestedDurationHours: number,
  now = Date.now(),
) {
  if (!isValidShieldDuration(requestedDurationHours)) return false;
  const continuousStartedAt = isTerritoryShieldActive(shield, now)
    ? shield!.startedAt
    : now;
  const requestedExpiresAt =
    now + requestedDurationHours * SHIELD_RULES.millisecondsPerHour;
  return requestedExpiresAt - continuousStartedAt <= MAX_SHIELD_DURATION_MS;
}

export function formatShieldRemainingTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function getFreeShieldAvailableAt(lastClaimedAt?: number | null) {
  return lastClaimedAt == null
    ? 0
    : lastClaimedAt +
        SHIELD_RULES.freeCooldownHours * SHIELD_RULES.millisecondsPerHour;
}

export function isFreeShieldAvailable(
  lastClaimedAt?: number | null,
  now = Date.now(),
) {
  return now >= getFreeShieldAvailableAt(lastClaimedAt);
}

export function canPlayerConquerTerritory(
  territory: Territory,
  challengerPlayerId: string,
  now = Date.now(),
) {
  return (
    territory.playerId === challengerPlayerId ||
    !isTerritoryShieldActive(territory.shield, now)
  );
}

export function shouldActivateShieldForPayment(
  paymentStatus: string | null | undefined,
) {
  return paymentStatus === "paid" || paymentStatus === "no_payment_required";
}

export function shouldOpenShieldOptions(_state: PlayerShieldIndicatorState) {
  return true;
}

export function activateTerritoryShield(
  territory: Territory,
  requestedDurationHours: number,
  now = Date.now(),
): Territory {
  return {
    ...territory,
    shield: createTerritoryShield(
      requestedDurationHours,
      now,
      territory.shield,
    ),
  };
}

export function withoutExpiredTerritoryShield(
  territory: Territory,
  now = Date.now(),
): Territory {
  if (!territory.shield) return territory;
  return isTerritoryShieldActive(territory.shield, now)
    ? territory
    : { ...territory, shield: null };
}

export function sanitizeTerritoryShield(territory: Territory): Territory {
  if (territory.shield === undefined || territory.shield === null) {
    return territory;
  }
  return isValidTerritoryShield(territory.shield)
    ? territory
    : { ...territory, shield: null };
}
