import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  collectStoredCoin,
  filterStoredAvailableCoins,
  getStoredCoinBalance,
  getStoredCoinCatalog,
  getStoredCoinCatalogForRegions,
  importLegacyCoinBalance,
  importLegacyCollectedCoinIds,
  markStoredCoinsUnavailableGlobally,
  saveCoinCatalogToStorage,
  spendStoredCoins,
} from "@/services/offline-storage";
import { neighboringRoadRegionIds } from "@/services/offline-storage";
import { supabase } from "@/services/supabase";
import type { WorldCoin } from "@/services/world-coins";

const LEGACY_COIN_STORAGE_KEY = "@paintfoot/coins-v1";
const LEGACY_COIN_EVENTS_KEY = "@paintfoot/coin-events-v1";
const LEGACY_WORLD_COIN_CATALOG_KEY = "@paintfoot/slrc-world-coins-v2";
const SQLITE_MIGRATION_KEY = "@paintfoot/coins-sqlite-migrated-v1";

export interface MapCoin extends WorldCoin {
  availableAt?: number;
}

type CoinListener = (balance: number) => void;
const listeners = new Set<CoinListener>();
let migrationPromise: Promise<void> | null = null;

function normalizeLegacyCoin(value: Partial<MapCoin>): MapCoin | null {
  if (
    typeof value.id !== "string" ||
    !Number.isFinite(value.latitude) ||
    !Number.isFinite(value.longitude) ||
    !Number.isFinite(value.value)
  ) return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  const latitudeCell = Math.floor((latitude + 90) / 0.02);
  const longitudeCell = Math.floor((longitude + 180) / 0.02);
  return {
    id: value.id,
    latitude,
    longitude,
    value: Math.max(1, Math.floor(Number(value.value))),
    regionId: value.regionId ?? `region_${latitudeCell}_${longitudeCell}`,
    roadSegmentId: value.roadSegmentId ?? "legacy-road",
    segmentIndex: value.segmentIndex ?? 0,
    densityVersion: value.densityVersion ?? 1,
    source: "osm_road",
    hash: value.hash ?? value.id.replace(/[^a-zA-Z0-9]/g, "").slice(-32),
    availableAt: value.availableAt,
  };
}

async function ensureSQLiteMigration() {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    if (await AsyncStorage.getItem(SQLITE_MIGRATION_KEY)) return;
    const [legacyBalance, legacyEvents, legacyCatalog] = await Promise.all([
      AsyncStorage.getItem(LEGACY_COIN_STORAGE_KEY),
      AsyncStorage.getItem(LEGACY_COIN_EVENTS_KEY),
      AsyncStorage.getItem(LEGACY_WORLD_COIN_CATALOG_KEY),
    ]);
    let parsedCatalog: MapCoin[] = [];
    try {
      parsedCatalog = legacyCatalog
        ? (JSON.parse(legacyCatalog) as Partial<MapCoin>[])
            .map(normalizeLegacyCoin)
            .filter((coin): coin is MapCoin => coin !== null)
        : [];
    } catch {
      parsedCatalog = [];
    }
    if (parsedCatalog.length > 0) await saveCoinCatalogToStorage(parsedCatalog);
    await importLegacyCoinBalance(Number(legacyBalance) || 0);
    if (legacyEvents) {
      try {
        await importLegacyCollectedCoinIds(JSON.parse(legacyEvents) as string[]);
      } catch {
        // Un indice legado corrupto no impide iniciar la base SQLite nueva.
      }
    }
    await AsyncStorage.setItem(SQLITE_MIGRATION_KEY, "1");
  })().catch((error) => {
    migrationPromise = null;
    throw error;
  });
  return migrationPromise;
}

async function publishBalance() {
  const balance = await getStoredCoinBalance();
  listeners.forEach((listener) => listener(balance));
  return balance;
}

export function notifyCoinBalanceChanged() {
  return publishBalance();
}

export async function getCoinBalance() {
  await ensureSQLiteMigration();
  return getStoredCoinBalance();
}

export async function spendCoins(amount: number) {
  await ensureSQLiteMigration();
  const spent = await spendStoredCoins(amount);
  if (spent) await publishBalance();
  return spent;
}

export async function collectCoin(coin: MapCoin, playerId = "local-player") {
  await ensureSQLiteMigration();
  const collected = await collectStoredCoin(coin, playerId);
  if (collected) await publishBalance();
  return collected;
}

export async function filterUncollectedCoins(coins: MapCoin[]) {
  let available = coins;
  try {
    await ensureSQLiteMigration();
    available = await filterStoredAvailableCoins(coins);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/database is locked|database is busy|SQLITE_BUSY/i.test(message)) throw error;
    // Un bloqueo corto provocado por tracking en segundo plano no debe vaciar
    // el mapa. La siguiente lectura vuelve a reconciliar el estado persistido.
  }
  const client = supabase;
  if (!client || available.length === 0) return available;

  // SQLite reaches the map immediately; global reconciliation must not leave
  // the screen empty while a request is slow or the device is offline.
  void reconcileUnavailableGlobalCoins(client, available);
  return available;
}

async function reconcileUnavailableGlobalCoins(
  client: NonNullable<typeof supabase>,
  available: MapCoin[],
) {
  try {
    const session = await client.auth.getSession();
    if (!session.data.session) return;
    const regionIds = [...new Set(available.map((coin) => coin.regionId))];
    const globallyUnavailable: string[] = [];
    for (let offset = 0; offset < regionIds.length; offset += 50) {
      const { data, error } = await client
        .from("world_coins")
        .select("id,status")
        .in("region_id", regionIds.slice(offset, offset + 50))
        .neq("status", "available");
      if (error) throw error;
      globallyUnavailable.push(...(data ?? []).map((row) => String(row.id)));
    }
    await markStoredCoinsUnavailableGlobally(globallyUnavailable);
  } catch {
    // Sin Internet se conserva exactamente el estado disponible en SQLite.
  }
}

export async function getStoredWorldCoinCatalog(): Promise<MapCoin[]> {
  await ensureSQLiteMigration();
  const stored = await getStoredCoinCatalog();
  return stored
    .map(({ status: _status, createdAt: _createdAt, updatedAt: _updatedAt,
      collectedAt: _collectedAt, collectedBy: _collectedBy,
      syncStatus: _syncStatus, ...coin }) => coin);
}

export async function getStoredWorldCoinCatalogNear(
  centers: Array<{ latitude: number; longitude: number }>,
): Promise<MapCoin[]> {
  await ensureSQLiteMigration();
  const regionIds = [
    ...new Set(centers.flatMap((center) => neighboringRoadRegionIds(center, 1))),
  ];
  const stored = await getStoredCoinCatalogForRegions(regionIds);
  return stored.map(({ status: _status, createdAt: _createdAt, updatedAt: _updatedAt,
    collectedAt: _collectedAt, collectedBy: _collectedBy,
    syncStatus: _syncStatus, ...coin }) => coin);
}

export async function saveWorldCoinCatalog(
  coins: MapCoin[],
  playerId = "",
) {
  await ensureSQLiteMigration();
  await saveCoinCatalogToStorage(coins, playerId);
  // Copia de compatibilidad regenerable; SQLite sigue siendo la fuente principal.
  await AsyncStorage.setItem(LEGACY_WORLD_COIN_CATALOG_KEY, JSON.stringify(coins));
}

export function subscribeToCoinBalance(listener: CoinListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
