import AsyncStorage from "@react-native-async-storage/async-storage";

export type ShieldPurchaseStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "canceled";

export interface ShieldPurchaseRecord {
  id: string;
  playerId: string;
  territoryId: string | null;
  productId: string;
  durationHours: number;
  amount: number | null;
  currency: string | null;
  status: ShieldPurchaseStatus;
  createdAt: number;
  stripeMode: "test" | "live";
  sessionId?: string | null;
}

const STORAGE_KEY = "@paintfoot/shield-purchase-history-v1";
const MAXIMUM_RECORDS = 50;
const listeners = new Set<(records: ShieldPurchaseRecord[]) => void>();
let historyQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is ShieldPurchaseRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ShieldPurchaseRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.playerId === "string" &&
    (record.territoryId === null || typeof record.territoryId === "string") &&
    typeof record.productId === "string" &&
    typeof record.durationHours === "number" &&
    typeof record.createdAt === "number" &&
    ["pending", "approved", "rejected", "canceled"].includes(
      record.status ?? "",
    )
  );
}

async function readHistory() {
  const stored = await AsyncStorage.getItem(STORAGE_KEY);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

export function getShieldPurchaseHistory(playerId: string) {
  return historyQueue.then(async () => {
    const records = await readHistory();
    return records.filter((record) => record.playerId === playerId);
  });
}

export function saveShieldPurchaseRecord(record: ShieldPurchaseRecord) {
  const operation = historyQueue.then(async () => {
    const records = await readHistory();
    const next = [record, ...records.filter((item) => item.id !== record.id)]
      .sort((first, second) => second.createdAt - first.createdAt)
      .slice(0, MAXIMUM_RECORDS);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    for (const listener of listeners) listener(next);
  });
  historyQueue = operation.catch(() => undefined);
  return operation;
}

export function subscribeToShieldPurchaseHistory(
  listener: (records: ShieldPurchaseRecord[]) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
