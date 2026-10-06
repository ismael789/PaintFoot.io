import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  getOfflineTerritories,
  saveOfflineTerritories,
} from "@/services/offline-storage";
import { sanitizeTerritoryShield } from "@/services/territory-shields";
import type { Territory } from "@/types/game";

// Se lee una sola vez para migrar datos creados antes de usar SQLite.
const LEGACY_TERRITORY_STORAGE_KEY = "@paintfoot/territories-v1";

let storageQueue: Promise<void> = Promise.resolve();
let migrationPromise: Promise<void> | null = null;
const territoryListeners = new Set<(territories: Territory[]) => void>();

function serializeStorageOperation<T>(operation: () => Promise<T>) {
  const result = storageQueue.then(operation, operation);
  storageQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isStoredTerritory(value: unknown): value is Territory {
  if (!value || typeof value !== "object") return false;
  const territory = value as Partial<Territory>;
  return (
    typeof territory.id === "string" &&
    typeof territory.playerId === "string" &&
    typeof territory.playerColor === "string" &&
    typeof territory.areaM2 === "number" &&
    typeof territory.createdAt === "number" &&
    typeof territory.signature === "string" &&
    Array.isArray(territory.coordinates) &&
    territory.polygon?.type === "Polygon" &&
    Array.isArray(territory.polygon.coordinates)
  );
}

async function migrateLegacyTerritoriesOnce() {
  const existing = await getOfflineTerritories();
  if (existing.length > 0) return;
  const legacy = await AsyncStorage.getItem(LEGACY_TERRITORY_STORAGE_KEY);
  if (!legacy) return;
  try {
    const parsed = JSON.parse(legacy) as unknown;
    const territories = Array.isArray(parsed)
      ? parsed.filter(isStoredTerritory).map(sanitizeTerritoryShield)
      : [];
    await saveOfflineTerritories(territories);
  } catch (error) {
    console.warn("[Offline] No se pudieron migrar los territorios:", error);
  } finally {
    await AsyncStorage.removeItem(LEGACY_TERRITORY_STORAGE_KEY);
  }
}

function ensureMigrated() {
  migrationPromise ??= migrateLegacyTerritoriesOnce();
  return migrationPromise;
}

async function readTerritories() {
  await ensureMigrated();
  return (await getOfflineTerritories())
    .filter(isStoredTerritory)
    .map(sanitizeTerritoryShield);
}

export function getStoredTerritories() {
  return serializeStorageOperation(readTerritories);
}

export function appendStoredTerritories(newTerritories: Territory[]) {
  if (newTerritories.length === 0) return Promise.resolve<Territory[]>([]);

  return serializeStorageOperation(async () => {
    const stored = await readTerritories();
    const bySignature = new Map(
      stored.map((territory) => [territory.signature, territory]),
    );
    for (const territory of newTerritories) {
      const sanitizedTerritory = sanitizeTerritoryShield(territory);
      bySignature.set(sanitizedTerritory.signature, sanitizedTerritory);
    }
    const nextTerritories = [...bySignature.values()].sort(
      (first, second) => first.createdAt - second.createdAt,
    );

    await saveOfflineTerritories(nextTerritories);
    for (const listener of territoryListeners) listener(nextTerritories);
    return nextTerritories;
  });
}

export function updateStoredTerritory(updatedTerritory: Territory) {
  return appendStoredTerritories([updatedTerritory]);
}

export function subscribeToStoredTerritories(
  listener: (territories: Territory[]) => void,
) {
  territoryListeners.add(listener);
  return () => {
    territoryListeners.delete(listener);
  };
}
