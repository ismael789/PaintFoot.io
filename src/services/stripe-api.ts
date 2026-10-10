import Constants from "expo-constants";
import type { TerritoryShield } from "../types/game";
import { buildEndpointCandidates } from "./network-endpoints";

export interface StripeConnectionStatus {
  connected: boolean;
  mode: "test" | "live";
  currency: string;
  checkout_configured: boolean;
  webhook_configured: boolean;
}

export interface StripePriceSummary {
  id: string;
  currency: string;
  unit_amount: number | null;
  type: "one_time" | "recurring";
  source: "inline" | "price";
  product: { id: string; name: string | null };
}

export interface StripeCheckoutSession {
  session_id: string;
  url: string | null;
  status: "open" | "complete" | "expired" | null;
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total: number | null;
  currency: string | null;
  reference_id: string | null;
  expires_at: number;
}

export interface ShieldProduct {
  id: string;
  duration_hours: 1 | 6 | 12 | 24 | 36;
  configured: boolean;
  price_id?: string | null;
  currency?: string | null;
  unit_amount?: number | null;
  name?: string | null;
}

export interface ShieldServerStatus {
  shield: TerritoryShield | null;
  free_last_claimed_at: number | null;
  free_available_at: number;
  free_available: boolean;
}

export interface PurchasedShield {
  id: string;
  durationHours: number;
  productId: string;
  amount: number | null;
  currency: string | null;
  stripeMode: "test" | "live";
  purchasedAt: number;
}

export interface ServerShieldPurchaseHistory {
  id: string;
  sessionId: string;
  productId: string;
  territoryId: string | null;
  durationHours: number;
  amount: number | null;
  currency: string | null;
  stripeMode: "test" | "live";
  status: "pending" | "approved" | "rejected" | "canceled";
  createdAt: number;
}

export type PlayerShieldServerStatus = Omit<ShieldServerStatus, "shield"> & {
  purchased_shields: PurchasedShield[];
  purchase_history: ServerShieldPurchaseHistory[];
};

let resolvedStripeApiBaseUrl: string | null = null;

function stripeApiBaseUrls() {
  return buildEndpointCandidates(
    process.env.EXPO_PUBLIC_STRIPE_API_URL,
    Constants.expoConfig?.hostUri,
    { scheme: "http", defaultPort: 4000, fallbackPath: "/api/stripe" },
  );
}

async function resolveStripeApiBaseUrl() {
  if (resolvedStripeApiBaseUrl) return resolvedStripeApiBaseUrl;

  const candidates = stripeApiBaseUrls();
  if (candidates.length === 0) {
    throw new Error(
      "Configura EXPO_PUBLIC_STRIPE_API_URL con la direccion del servidor de pagos",
    );
  }

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await fetch(`${candidate}/config`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.headers.get("X-PaintFoot-Server") === "stripe-api") {
        resolvedStripeApiBaseUrl = candidate;
        return candidate;
      }
    } catch {
      // Probar el siguiente puerto disponible.
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("No se encontro el servidor de pagos de PaintFoot.io");
}

async function stripeFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = await resolveStripeApiBaseUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: controller.signal,
    });
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(data.error || "No se pudo completar la operacion Stripe");
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export function checkStripeConnection() {
  return stripeFetch<StripeConnectionStatus>("/connection");
}

export async function getStripePrices() {
  const response = await stripeFetch<{ prices: StripePriceSummary[] }>(
    "/prices",
  );
  return response.prices;
}

export function createStripeCheckout(input: {
  itemId?: string;
  priceId?: string;
  referenceId: string;
  quantity?: number;
}) {
  return stripeFetch<StripeCheckoutSession>("/checkout", {
    method: "POST",
    body: JSON.stringify({
      price_id: input.priceId,
      item_id: input.itemId,
      reference_id: input.referenceId,
      quantity: input.quantity ?? 1,
    }),
  });
}

export function getStripeCheckoutSession(sessionId: string) {
  return stripeFetch<StripeCheckoutSession>(
    `/session/${encodeURIComponent(sessionId)}`,
  );
}

export async function getShieldProducts() {
  const response = await stripeFetch<{
    products: ShieldProduct[];
    maximum_duration_hours: number;
  }>("/shield-products");
  return response.products;
}

export function getShieldServerStatus(territoryId: string, playerId: string) {
  return stripeFetch<ShieldServerStatus>(
    `/shield/status?territory_id=${encodeURIComponent(territoryId)}&player_id=${encodeURIComponent(playerId)}`,
  );
}

export function getPlayerShieldServerStatus(playerId: string) {
  return stripeFetch<PlayerShieldServerStatus>(
    `/shield/player-status?player_id=${encodeURIComponent(playerId)}`,
  );
}

export function claimFreeTerritoryShield(territoryId: string, playerId: string) {
  return stripeFetch<{ shield: TerritoryShield; free_available_at: number }>(
    "/shield/free",
    {
      method: "POST",
      body: JSON.stringify({ territory_id: territoryId, player_id: playerId }),
    },
  );
}

export function createShieldCheckout(input: {
  productId: string;
  territoryId?: string | null;
  playerId: string;
  purchaseReference: string;
  returnUrl: string;
}) {
  return stripeFetch<StripeCheckoutSession>("/shield/checkout", {
    method: "POST",
    body: JSON.stringify({
      product_id: input.productId,
      ...(input.territoryId ? { territory_id: input.territoryId } : {}),
      player_id: input.playerId,
      purchase_reference: input.purchaseReference,
      return_url: input.returnUrl,
    }),
  });
}

export function confirmShieldCheckout(
  sessionId: string,
  territoryId: string | null,
  playerId: string,
) {
  return stripeFetch<{
    shield: TerritoryShield | null;
    purchased_shield: PurchasedShield | null;
    payment_id: string;
  }>(
    "/shield/confirm",
    {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionId,
        ...(territoryId ? { territory_id: territoryId } : {}),
        player_id: playerId,
      }),
    },
  );
}

export function activatePurchasedTerritoryShield(
  purchasedShieldId: string,
  territoryId: string,
  playerId: string,
) {
  return stripeFetch<{ shield: TerritoryShield; purchased_shield_id: string }>(
    "/shield/activate-purchased",
    {
      method: "POST",
      body: JSON.stringify({
        purchased_shield_id: purchasedShieldId,
        territory_id: territoryId,
        player_id: playerId,
      }),
    },
  );
}
