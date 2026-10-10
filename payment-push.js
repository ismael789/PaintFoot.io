const { createClient } = require("@supabase/supabase-js");

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

const PAYMENT_PUSH_CONTENT = Object.freeze({
  approved: {
    title: "Pago aprobado",
    body: "Tu protección fue activada.",
    kind: "payment-approved",
  },
  rejected: {
    title: "No se pudo completar el pago",
    body: "Tu territorio no fue modificado.",
    kind: "payment-rejected",
  },
  canceled: {
    title: "Pago cancelado",
    body: "No se realizó ningún cobro.",
    kind: "payment-canceled",
  },
});

function createPushClient() {
  const url = String(process.env.EXPO_PUBLIC_SUPABASE_URL || "").trim();
  const key = String(
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  ).trim();
  if (!/^https:\/\//.test(url) || !key || key.includes("REEMPLAZAR")) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function isExpoPushToken(value) {
  return typeof value === "string" && /^(Expo|Exponent)PushToken\[[^\]]+\]$/.test(value);
}

function paymentBody(durationHours, amount, currency) {
  const price = Number.isInteger(amount) && currency
    ? new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency: String(currency).toUpperCase(),
      }).format(amount / 100)
    : "importe confirmado";
  return `Compraste un escudo de ${durationHours} h por ${price}. Ya está en tu inventario.`;
}

async function sendPaymentStatusPush({ playerId, sessionId, status }) {
  const content = PAYMENT_PUSH_CONTENT[status];
  const supabase = createPushClient();
  if (!content || !supabase || !/^[0-9a-f-]{36}$/i.test(playerId || "")) return false;

  const eventKey = `payment_${status}:${sessionId}`;
  const [tokensResult, preferencesResult] = await Promise.all([
    supabase
      .from("push_tokens")
      .select("expo_push_token")
      .eq("user_id", playerId)
      .eq("enabled", true),
    supabase
      .from("notification_preferences")
      .select("payments")
      .eq("user_id", playerId)
      .maybeSingle(),
  ]);
  if (tokensResult.error) throw tokensResult.error;
  if (preferencesResult.error) throw preferencesResult.error;
  if (preferencesResult.data?.payments === false) return false;

  const destinations = [
    ...new Set(
      (tokensResult.data || [])
        .map((row) => row.expo_push_token)
        .filter(isExpoPushToken),
    ),
  ];
  if (destinations.length === 0) return false;

  const { error: claimError } = await supabase.from("notification_log").insert({
    user_id: playerId,
    event_key: eventKey,
    category: "payments",
    title: content.title,
  });
  if (claimError?.code === "23505") return false;
  if (claimError) throw claimError;

  try {
    const response = await fetch(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(
        destinations.map((to) => ({
          to,
          sound: "default",
          title: content.title,
          body: content.body,
          data: {
            url: "paintfoot://payments",
            sessionId,
            kind: content.kind,
          },
          channelId: "paintfoot-payments",
        })),
      ),
    });
    if (!response.ok) throw new Error(`Expo Push respondio ${response.status}`);
    return true;
  } catch (error) {
    await supabase
      .from("notification_log")
      .delete()
      .eq("user_id", playerId)
      .eq("event_key", eventKey);
    throw error;
  }
}

function sendPaymentApprovedPush(values) {
  return sendPaymentStatusPush({ ...values, status: "approved" });
}

module.exports = {
  PAYMENT_PUSH_CONTENT,
  paymentBody,
  sendPaymentApprovedPush,
  sendPaymentStatusPush,
};
