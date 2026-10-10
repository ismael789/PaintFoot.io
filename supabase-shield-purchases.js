const { createClient } = require("@supabase/supabase-js");

let client;
let warned = false;

function getClient() {
  if (client !== undefined) return client;
  const url = String(process.env.EXPO_PUBLIC_SUPABASE_URL || "").trim();
  const key = String(
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  ).trim();
  client = /^https:\/\//.test(url) && key && !key.includes("REEMPLAZAR")
    ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;
  return client;
}

function warnOnce(error) {
  if (warned) return;
  warned = true;
  console.warn(`[Stripe] Inventario Supabase no disponible; se conserva el respaldo del servidor: ${error.message}`);
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || "");
}

async function saveVerifiedShieldPurchase({ session, product, territoryId = null }) {
  const supabase = getClient();
  if (!supabase || !validUuid(session.metadata?.player_id)) return false;
  const paidAt = new Date((session.created || Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const payment = {
    checkout_session_id: session.id,
    payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null,
    player_id: session.metadata.player_id,
    territory_id: territoryId || null,
    product_id: product.id,
    duration_hours: product.durationHours,
    currency: session.currency,
    unit_amount: session.amount_total,
    status: "paid",
    stripe_mode: session.livemode ? "live" : "test",
    purchase_reference: session.client_reference_id || null,
    metadata: session.metadata || {},
    paid_at: paidAt,
  };
  try {
    const { error: paymentError } = await supabase
      .from("paintfoot_stripe_payments")
      .upsert(payment, { onConflict: "checkout_session_id" });
    if (paymentError) throw paymentError;
    const { error: inventoryError } = await supabase
      .from("paintfoot_shield_inventory")
      .upsert({
        checkout_session_id: session.id,
        player_id: session.metadata.player_id,
        product_id: product.id,
        duration_hours: product.durationHours,
        currency: session.currency,
        unit_amount: session.amount_total,
        stripe_mode: session.livemode ? "live" : "test",
        status: "available",
        purchased_at: paidAt,
      }, { onConflict: "checkout_session_id", ignoreDuplicates: true });
    if (inventoryError) throw inventoryError;
    warned = false;
    return true;
  } catch (error) {
    warnOnce(error);
    return false;
  }
}

async function getPlayerShieldPurchases(playerId) {
  const supabase = getClient();
  if (!supabase || !validUuid(playerId)) return null;
  try {
    const [inventoryResult, historyResult] = await Promise.all([
      supabase
        .from("paintfoot_shield_inventory")
        .select("checkout_session_id,product_id,duration_hours,currency,unit_amount,stripe_mode,purchased_at")
        .eq("player_id", playerId)
        .eq("status", "available")
        .order("purchased_at", { ascending: true }),
      supabase
        .from("paintfoot_stripe_payments")
        .select("checkout_session_id,product_id,territory_id,duration_hours,currency,unit_amount,status,stripe_mode,purchase_reference,paid_at,created_at")
        .eq("player_id", playerId)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    if (inventoryResult.error) throw inventoryResult.error;
    if (historyResult.error) throw historyResult.error;
    warned = false;
    return {
      inventory: (inventoryResult.data || []).map((row) => ({
        id: row.checkout_session_id,
        productId: row.product_id,
        durationHours: row.duration_hours,
        amount: row.unit_amount,
        currency: row.currency,
        stripeMode: row.stripe_mode,
        purchasedAt: Date.parse(row.purchased_at),
      })),
      history: (historyResult.data || []).map((row) => ({
        id: row.purchase_reference || row.checkout_session_id,
        sessionId: row.checkout_session_id,
        productId: row.product_id,
        territoryId: row.territory_id,
        durationHours: row.duration_hours,
        amount: row.unit_amount,
        currency: row.currency,
        stripeMode: row.stripe_mode,
        status: row.status === "paid" ? "approved" : row.status,
        createdAt: Date.parse(row.paid_at || row.created_at),
      })),
    };
  } catch (error) {
    warnOnce(error);
    return null;
  }
}

async function markPurchasedShieldActivated(checkoutSessionId, territoryId) {
  const supabase = getClient();
  if (!supabase) return false;
  try {
    const now = new Date().toISOString();
    const { error: inventoryError } = await supabase
      .from("paintfoot_shield_inventory")
      .update({ status: "activated", territory_id: territoryId, activated_at: now })
      .eq("checkout_session_id", checkoutSessionId)
      .eq("status", "available");
    if (inventoryError) throw inventoryError;
    const { error: paymentError } = await supabase
      .from("paintfoot_stripe_payments")
      .update({ territory_id: territoryId, activated_at: now })
      .eq("checkout_session_id", checkoutSessionId);
    if (paymentError) throw paymentError;
    return true;
  } catch (error) {
    warnOnce(error);
    return false;
  }
}

module.exports = {
  getPlayerShieldPurchases,
  markPurchasedShieldActivated,
  saveVerifiedShieldPurchase,
};
