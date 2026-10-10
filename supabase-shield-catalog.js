const ALLOWED_DURATIONS = new Set([1, 6, 12, 24, 36]);
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 4_000;

let cachedProducts = null;
let cachedAt = 0;
let pendingRequest = null;
let warned = false;

function configuredSupabaseAccess() {
  const url = String(process.env.EXPO_PUBLIC_SUPABASE_URL || "").trim().replace(/\/$/, "");
  const secret = String(process.env.SUPABASE_SECRET_KEY || "").trim();
  const publicKey = String(
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
      "",
  ).trim();
  const key = secret && !secret.includes("REEMPLAZAR") ? secret : publicKey;
  return /^https:\/\//.test(url) && key ? { url, key } : null;
}

function normalizeCatalogRow(row) {
  const durationHours = Number(row?.duration_hours);
  const unitAmount = Number(row?.unit_amount);
  const id = String(row?.id || "");
  const currency = String(row?.currency || "").toLowerCase();
  const priceId = String(row?.stripe_price_id || "").trim();
  if (
    row?.active !== true ||
    !ALLOWED_DURATIONS.has(durationHours) ||
    id !== `shield_${durationHours}h` ||
    !Number.isInteger(unitAmount) ||
    unitAmount <= 0 ||
    !/^[a-z]{3}$/.test(currency) ||
    (priceId && !/^price_[A-Za-z0-9]+$/.test(priceId))
  ) {
    return null;
  }
  return {
    id,
    name: String(row.name || `Escudo ${durationHours} horas`).slice(0, 120),
    durationHours,
    currency,
    priceId: priceId || null,
    inlineUnitAmount: unitAmount,
    source: "supabase",
  };
}

async function requestSupabaseCatalog() {
  const access = configuredSupabaseAccess();
  if (!access || process.env.NODE_TEST_CONTEXT) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const select = "id,name,duration_hours,currency,unit_amount,stripe_price_id,active";
    const response = await fetch(
      `${access.url}/rest/v1/paintfoot_shield_products?select=${select}&active=eq.true&order=duration_hours.asc`,
      {
        headers: {
          apikey: access.key,
          Authorization: `Bearer ${access.key}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`Supabase respondio ${response.status}`);
    const rows = await response.json();
    const products = Array.isArray(rows)
      ? rows.map(normalizeCatalogRow).filter(Boolean)
      : [];
    if (products.length !== ALLOWED_DURATIONS.size) {
      throw new Error("el catalogo no contiene los cinco escudos activos");
    }
    return products;
  } finally {
    clearTimeout(timeout);
  }
}

async function getSupabaseShieldCatalog() {
  if (cachedProducts && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedProducts;
  }
  if (!pendingRequest) {
    pendingRequest = requestSupabaseCatalog()
      .then((products) => {
        if (products) {
          cachedProducts = products;
          cachedAt = Date.now();
          warned = false;
        }
        return products;
      })
      .catch((error) => {
        if (!warned) {
          warned = true;
          console.warn(`[Stripe] Catalogo Supabase no disponible; usando respaldo local: ${error.message}`);
        }
        return cachedProducts;
      })
      .finally(() => {
        pendingRequest = null;
      });
  }
  return pendingRequest;
}

module.exports = { getSupabaseShieldCatalog, normalizeCatalogRow };
