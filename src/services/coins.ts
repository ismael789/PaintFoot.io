import AsyncStorage from "@react-native-async-storage/async-storage";

import type { GeoCoordinate } from "@/types/game";

const COIN_STORAGE_KEY = "@paintfoot/coins-v1";
const COIN_EVENTS_KEY = "@paintfoot/coin-events-v1";

export interface MapCoin extends GeoCoordinate {
  id: string;
  value: number;
  availableAt?: number;
}

type CoinListener = (balance: number) => void;
const listeners = new Set<CoinListener>();
let balanceCache: number | null = null;
let eventsCache: Set<string> | null = null;

async function loadBalance() {
  if (balanceCache !== null) return balanceCache;
  balanceCache = Number(await AsyncStorage.getItem(COIN_STORAGE_KEY)) || 0;
  return balanceCache;
}

async function loadEvents() {
  if (eventsCache) return eventsCache;
  const raw = await AsyncStorage.getItem(COIN_EVENTS_KEY);
  eventsCache = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  return eventsCache;
}

export async function getCoinBalance() {
  return loadBalance();
}

export async function spendCoins(amount: number) {
  if (!Number.isInteger(amount) || amount <= 0) return false;
  const balance = await loadBalance();
  if (balance < amount) return false;
  balanceCache = balance - amount;
  await AsyncStorage.setItem(COIN_STORAGE_KEY, String(balanceCache));
  listeners.forEach((listener) => listener(balanceCache!));
  return true;
}

export async function collectCoin(coin: MapCoin) {
  const events = await loadEvents();
  if (events.has(coin.id)) return false;
  events.add(coin.id);
  balanceCache = (await loadBalance()) + Math.max(1, coin.value);
  await Promise.all([
    AsyncStorage.setItem(COIN_STORAGE_KEY, String(balanceCache)),
    AsyncStorage.setItem(COIN_EVENTS_KEY, JSON.stringify([...events].slice(-1000))),
  ]);
  listeners.forEach((listener) => listener(balanceCache!));
  return true;
}

export function subscribeToCoinBalance(listener: CoinListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
