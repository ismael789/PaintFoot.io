const crypto = require("crypto");
const http = require("http");
const { URL } = require("url");

require("dotenv").config();

const Stripe = require("stripe");
const { shieldServerStore, MAX_SHIELD_DURATION_HOURS } = require("./shield-server-store");

const DEFAULT_PORT = 4000;
const MAX_BODY_BYTES = 128 * 1024;
const SHIELD_PRODUCTS = [1, 6, 12, 24, 36].map((durationHours) => ({
  id: `shield_${durationHours}h`,
  durationHours,
  environmentVariable: `STRIPE_SHIELD_${durationHours}H_PRICE_ID`,
}));

function shieldProductsConfiguration() {
  return SHIELD_PRODUCTS.map((product) => {
    const priceId = String(process.env[product.environmentVariable] || "").trim();
    return {
      ...product,
      priceId: /^price_[A-Za-z0-9]+$/.test(priceId) ? priceId : null,
    };
  });
}

function findShieldProduct(productId) {
  return shieldProductsConfiguration().find((product) => product.id === productId) || null;
}

function normalizeCurrency(value = "mxn") {
  const currency = String(value).trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new Error("STRIPE_CURRENCY debe ser un codigo ISO 4217 de tres letras");
  }
  return currency;
}

function parseAllowedPriceIds(value = "") {
  return new Set(
    String(value)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => /^price_[A-Za-z0-9]+$/.test(item)),
  );
}

function buildCheckoutIdempotencyKey(referenceId, priceId, quantity) {
  const digest = crypto
    .createHash("sha256")
    .update(`${referenceId}:${priceId}:${quantity}`)
    .digest("hex");
  return `paintfoot_checkout_${digest}`;
}

function parsePositiveInteger(value, fallback = 1) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function configuredInlineItem() {
  const id = String(
    process.env.STRIPE_DEFAULT_ITEM_ID || "paintfoot_payment",
  ).trim();
  const name = String(
    process.env.STRIPE_DEFAULT_ITEM_NAME || "Pago PaintFoot.io",
  ).trim();
  const unitAmount = Number(process.env.STRIPE_DEFAULT_AMOUNT_CENTS || 0);
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(id) ||
    name.length === 0 ||
    name.length > 120 ||
    !Number.isInteger(unitAmount) ||
    unitAmount <= 0
  ) {
    return null;
  }
  return { id, name, unitAmount };
}

function validateRedirectUrl(value, variableName) {
  if (!value) throw new Error(`${variableName} no esta configurada`);
  const url = new URL(value);
  if (!["https:", "http:", "paintfootio:"].includes(url.protocol)) {
    throw new Error(`${variableName} utiliza un protocolo no permitido`);
  }
  return value;
}

function stripeConfiguration() {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim() || "";
  const publicKey =
    process.env.STRIPE_PUBLIC_KEY?.trim() ||
    process.env.VITE_STRIPE_PUBLIC_KEY?.trim() ||
    process.env.EXPO_PUBLIC_STRIPE_PUBLIC_KEY?.trim() ||
    "";
  const currency = normalizeCurrency(process.env.STRIPE_CURRENCY || "mxn");
  const allowedPriceIds = parseAllowedPriceIds(
    process.env.STRIPE_ALLOWED_PRICE_IDS,
  );

  return {
    secretKey,
    publicKey,
    currency,
    allowedPriceIds,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || "",
    successUrl: process.env.STRIPE_SUCCESS_URL?.trim() || "",
    cancelUrl: process.env.STRIPE_CANCEL_URL?.trim() || "",
    inlineItem: configuredInlineItem(),
  };
}

let stripeClient = null;
let stripeClientKey = null;

function getStripeClient() {
  const { secretKey } = stripeConfiguration();
  if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(secretKey)) {
    const error = new Error("STRIPE_SECRET_KEY no esta configurada correctamente");
    error.statusCode = 503;
    throw error;
  }
  if (
    secretKey.startsWith("sk_live_") &&
    process.env.ALLOW_STRIPE_LIVE_MODE !== "true"
  ) {
    const error = new Error(
      "La clave live esta bloqueada hasta configurar ALLOW_STRIPE_LIVE_MODE=true",
    );
    error.statusCode = 503;
    throw error;
  }
  if (!stripeClient || stripeClientKey !== secretKey) {
    stripeClient = new Stripe(secretKey, {
      maxNetworkRetries: 2,
      timeout: 15_000,
    });
    stripeClientKey = secretKey;
  }
  return stripeClient;
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  const configuredOrigins = String(process.env.STRIPE_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowedOrigin =
    !origin || configuredOrigins.length === 0
      ? "*"
      : configuredOrigins.includes(origin)
        ? origin
        : "null";
  return {
    "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Cache-Control": "no-store",
  };
}

function sendJson(response, request, statusCode, body) {
  response.writeHead(statusCode, {
    ...corsHeaders(request),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function sendHtml(response, request, statusCode, html) {
  response.writeHead(statusCode, {
    ...corsHeaders(request),
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function checkoutReturnUrls(request, configuration) {
  if (configuration.successUrl && configuration.cancelUrl) {
    return {
      successUrl: validateRedirectUrl(
        configuration.successUrl,
        "STRIPE_SUCCESS_URL",
      ),
      cancelUrl: validateRedirectUrl(
        configuration.cancelUrl,
        "STRIPE_CANCEL_URL",
      ),
    };
  }

  const host = request.headers.host;
  if (typeof host !== "string" || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) {
    const error = new Error("No se pudo determinar la URL publica de retorno");
    error.statusCode = 503;
    throw error;
  }
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  const baseUrl = `${protocol}://${host}/api/stripe/return`;
  return {
    successUrl: `${baseUrl}?result=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${baseUrl}?result=cancel`,
  };
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        const error = new Error("El cuerpo de la solicitud es demasiado grande");
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readJsonBody(request) {
  const rawBody = await readRawBody(request);
  if (rawBody.length === 0) return {};
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    const error = new Error("JSON no valido");
    error.statusCode = 400;
    throw error;
  }
}

function checkoutResponse(session) {
  return {
    session_id: session.id,
    url: session.url,
    status: session.status,
    payment_status: session.payment_status,
    amount_total: session.amount_total,
    currency: session.currency,
    reference_id: session.client_reference_id,
    expires_at: session.expires_at,
  };
}

async function handleConnection(request, response) {
  const stripe = getStripeClient();
  const balance = await stripe.balance.retrieve();
  const configuration = stripeConfiguration();
  sendJson(response, request, 200, {
    connected: true,
    mode: balance.livemode ? "live" : "test",
    currency: configuration.currency,
    checkout_configured:
      configuration.allowedPriceIds.size > 0 ||
      configuration.inlineItem !== null,
    webhook_configured: Boolean(configuration.webhookSecret),
  });
}

function handlePublicConfiguration(request, response) {
  const configuration = stripeConfiguration();
  sendJson(response, request, 200, {
    public_key: configuration.publicKey || null,
    currency: configuration.currency,
    mode: configuration.secretKey.startsWith("sk_live_") ? "live" : "test",
    checkout_configured:
      configuration.allowedPriceIds.size > 0 ||
      configuration.inlineItem !== null,
    webhook_configured: Boolean(configuration.webhookSecret),
  });
}

async function handlePrices(request, response) {
  const stripe = getStripeClient();
  const configuration = stripeConfiguration();
  const prices = await Promise.all(
    [...configuration.allowedPriceIds].map((priceId) =>
      stripe.prices.retrieve(priceId, { expand: ["product"] }),
    ),
  );
  sendJson(response, request, 200, {
    prices: [
      ...(configuration.inlineItem
        ? [
            {
              id: configuration.inlineItem.id,
              currency: configuration.currency,
              unit_amount: configuration.inlineItem.unitAmount,
              type: "one_time",
              source: "inline",
              product: { id: configuration.inlineItem.id, name: configuration.inlineItem.name },
            },
          ]
        : []),
      ...prices
      .filter(
        (price) =>
          price.active && price.currency === configuration.currency,
      )
      .map((price) => ({
        id: price.id,
        currency: price.currency,
        unit_amount: price.unit_amount,
        type: price.type,
        source: "price",
        product:
          typeof price.product === "string"
            ? { id: price.product, name: null }
            : { id: price.product.id, name: price.product.name },
      })),
    ],
  });
}

async function handleShieldProducts(request, response) {
  const stripe = getStripeClient();
  const configuration = stripeConfiguration();
  const products = await Promise.all(
    shieldProductsConfiguration().map(async (product) => {
      if (!product.priceId) {
        return { id: product.id, duration_hours: product.durationHours, configured: false };
      }
      try {
        const price = await stripe.prices.retrieve(product.priceId, { expand: ["product"] });
        const configured = Boolean(
          price.active &&
          price.type === "one_time" &&
          price.currency === configuration.currency &&
          price.unit_amount != null,
        );
        return {
          id: product.id,
          duration_hours: product.durationHours,
          configured,
          price_id: configured ? price.id : null,
          currency: configured ? price.currency : null,
          unit_amount: configured ? price.unit_amount : null,
          name:
            configured && typeof price.product !== "string"
              ? price.product.name
              : null,
        };
      } catch {
        return { id: product.id, duration_hours: product.durationHours, configured: false };
      }
    }),
  );
  sendJson(response, request, 200, { products, maximum_duration_hours: MAX_SHIELD_DURATION_HOURS });
}

function shieldStatusResponse(status) {
  return {
    shield: status.shield,
    free_last_claimed_at: status.free_last_claimed_at,
    free_available_at: status.free_available_at,
    free_available: status.free_available,
  };
}

function validatedIdentity(body) {
  const territoryId = typeof body.territory_id === "string" ? body.territory_id.trim() : "";
  const playerId = typeof body.player_id === "string" ? body.player_id.trim() : "";
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(territoryId) ||
      !/^[A-Za-z0-9_.:-]{1,160}$/.test(playerId)) {
    const error = new Error("territory_id o player_id no valido");
    error.statusCode = 400;
    throw error;
  }
  return { territoryId, playerId };
}

function handleShieldStatus(request, response, url) {
  const identity = validatedIdentity({
    territory_id: url.searchParams.get("territory_id"),
    player_id: url.searchParams.get("player_id"),
  });
  sendJson(response, request, 200, shieldStatusResponse(shieldServerStore.getStatus(identity.territoryId, identity.playerId)));
}

function handlePlayerShieldStatus(request, response, url) {
  const playerId = (url.searchParams.get("player_id") || "").trim();
  sendJson(
    response,
    request,
    200,
    shieldServerStore.getPlayerStatus(playerId),
  );
}

async function handleFreeShield(request, response) {
  const identity = validatedIdentity(await readJsonBody(request));
  const result = shieldServerStore.claimFree(identity.territoryId, identity.playerId);
  sendJson(response, request, 201, result);
}

async function handleShieldCheckout(request, response) {
  const body = await readJsonBody(request);
  const identity = validatedIdentity(body);
  const product = findShieldProduct(typeof body.product_id === "string" ? body.product_id : "");
  const purchaseReference = typeof body.purchase_reference === "string" ? body.purchase_reference.trim() : "";
  if (!product || !product.priceId || product.durationHours > MAX_SHIELD_DURATION_HOURS) {
    sendJson(response, request, 409, { error: "Producto de escudo no configurado" });
    return;
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(purchaseReference)) {
    sendJson(response, request, 400, { error: "purchase_reference no valido" });
    return;
  }
  shieldServerStore.assertOwnership(identity.territoryId, identity.playerId);

  const stripe = getStripeClient();
  const configuration = stripeConfiguration();
  const price = await stripe.prices.retrieve(product.priceId);
  if (!price.active || price.type !== "one_time" || price.currency !== configuration.currency) {
    sendJson(response, request, 409, { error: "El precio del escudo no esta activo o no es valido" });
    return;
  }
  const { successUrl, cancelUrl } = checkoutReturnUrls(request, configuration);
  const metadata = {
    purchase_type: "territory_shield",
    product_id: product.id,
    duration_hours: String(product.durationHours),
    territory_id: identity.territoryId,
    player_id: identity.playerId,
  };
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: [{ price: product.priceId, quantity: 1 }],
      client_reference_id: purchaseReference,
      metadata,
      payment_intent_data: { metadata },
      success_url: successUrl,
      cancel_url: cancelUrl,
    },
    { idempotencyKey: buildCheckoutIdempotencyKey(purchaseReference, product.priceId, 1) },
  );
  sendJson(response, request, 201, checkoutResponse(session));
}

function activateShieldFromCheckoutSession(session) {
  const metadata = session.metadata || {};
  if (metadata.purchase_type !== "territory_shield") return null;
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    const error = new Error("Stripe no confirmo el pago");
    error.statusCode = 409;
    throw error;
  }
  const product = findShieldProduct(metadata.product_id);
  const linePrice = session.line_items?.data?.[0]?.price;
  const linePriceId = typeof linePrice === "string" ? linePrice : linePrice?.id;
  if (!product || !product.priceId ||
      String(product.durationHours) !== metadata.duration_hours ||
      linePriceId !== product.priceId) {
    const error = new Error("Los datos del producto pagado no son validos");
    error.statusCode = 409;
    throw error;
  }
  return shieldServerStore.activate({
    territoryId: metadata.territory_id,
    playerId: metadata.player_id,
    durationHours: product.durationHours,
    source: "stripe",
    paymentId: session.id,
  });
}

async function handleShieldConfirmation(request, response) {
  const body = await readJsonBody(request);
  const identity = validatedIdentity(body);
  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    sendJson(response, request, 400, { error: "session_id no valido" });
    return;
  }
  const session = await getStripeClient().checkout.sessions.retrieve(sessionId, {
    expand: ["line_items.data.price"],
  });
  if (session.metadata?.territory_id !== identity.territoryId ||
      session.metadata?.player_id !== identity.playerId) {
    sendJson(response, request, 403, { error: "La sesion no pertenece a este territorio y jugador" });
    return;
  }
  const shield = activateShieldFromCheckoutSession(session);
  sendJson(response, request, 200, { shield, payment_id: session.id });
}

async function handleCheckout(request, response) {
  const body = await readJsonBody(request);
  const priceId = typeof body.price_id === "string" ? body.price_id.trim() : "";
  const itemId = typeof body.item_id === "string" ? body.item_id.trim() : "";
  const referenceId =
    typeof body.reference_id === "string" ? body.reference_id.trim() : "";
  const quantity = parsePositiveInteger(body.quantity, 1);
  const configuration = stripeConfiguration();

  const usesStripePrice = configuration.allowedPriceIds.has(priceId);
  const usesInlineItem =
    Boolean(configuration.inlineItem) &&
    itemId === configuration.inlineItem?.id;
  if (!usesStripePrice && !usesInlineItem) {
    sendJson(response, request, 400, { error: "Articulo o price_id no autorizado" });
    return;
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(referenceId)) {
    sendJson(response, request, 400, { error: "reference_id no valido" });
    return;
  }
  if (quantity === null || quantity > 10) {
    sendJson(response, request, 400, { error: "quantity debe estar entre 1 y 10" });
    return;
  }

  const stripe = getStripeClient();
  if (usesStripePrice) {
    const price = await stripe.prices.retrieve(priceId);
    if (!price.active || price.currency !== configuration.currency) {
      sendJson(response, request, 409, {
        error: "El precio no esta activo o utiliza otra moneda",
      });
      return;
    }
  }

  const { successUrl, cancelUrl } = checkoutReturnUrls(
    request,
    configuration,
  );
  const checkoutItemId = usesStripePrice ? priceId : itemId;
  const lineItem = usesStripePrice
    ? { price: priceId, quantity }
    : {
        price_data: {
          currency: configuration.currency,
          product_data: { name: configuration.inlineItem.name },
          unit_amount: configuration.inlineItem.unitAmount,
        },
        quantity,
      };
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: [lineItem],
      client_reference_id: referenceId,
      metadata: { reference_id: referenceId },
      payment_intent_data: { metadata: { reference_id: referenceId } },
      success_url: successUrl,
      cancel_url: cancelUrl,
    },
    {
      idempotencyKey: buildCheckoutIdempotencyKey(
        referenceId,
        checkoutItemId,
        quantity,
      ),
    },
  );
  sendJson(response, request, 201, checkoutResponse(session));
}

function handleCheckoutReturn(request, response, result) {
  const paid = result === "success";
  const title = paid ? "Pago enviado a Stripe" : "Pago cancelado";
  const message = paid
    ? "Stripe recibio el pago. Ya puedes cerrar esta ventana y volver a PaintFoot.io."
    : "No se realizo ningun cobro. Puedes cerrar esta ventana y volver a PaintFoot.io.";
  sendHtml(
    response,
    request,
    200,
    `<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{align-items:center;background:#101426;color:#fff;display:flex;font-family:system-ui;height:100vh;justify-content:center;margin:0}.card{background:#1a1a2e;border-radius:20px;box-sizing:border-box;max-width:430px;padding:32px;text-align:center;width:calc(100% - 32px)}h1{font-size:24px}p{color:#c5cae9;line-height:1.5}.mark{font-size:48px}</style></head><body><main class="card"><div class="mark">${paid ? "✓" : "×"}</div><h1>${title}</h1><p>${message}</p></main></body></html>`,
  );
}

async function handleSession(request, response, sessionId) {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    sendJson(response, request, 400, { error: "session_id no valido" });
    return;
  }
  const session = await getStripeClient().checkout.sessions.retrieve(sessionId);
  sendJson(response, request, 200, checkoutResponse(session));
}

async function handleWebhook(request, response) {
  const configuration = stripeConfiguration();
  if (!configuration.webhookSecret) {
    sendJson(response, request, 503, {
      error: "STRIPE_WEBHOOK_SECRET no esta configurada",
    });
    return;
  }
  const signature = request.headers["stripe-signature"];
  if (typeof signature !== "string") {
    sendJson(response, request, 400, { error: "Falta Stripe-Signature" });
    return;
  }
  const rawBody = await readRawBody(request);
  const event = getStripeClient().webhooks.constructEvent(
    rawBody,
    signature,
    configuration.webhookSecret,
  );
  if (
    (event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded") &&
    event.data.object?.metadata?.purchase_type === "territory_shield"
  ) {
    const session = await getStripeClient().checkout.sessions.retrieve(
      event.data.object.id,
      { expand: ["line_items.data.price"] },
    );
    activateShieldFromCheckoutSession(session);
  }
  console.log(`[Stripe] Webhook verificado: ${event.type} (${event.id})`);
  sendJson(response, request, 200, {
    received: true,
    event_id: event.id,
    type: event.type,
  });
}

async function handleStripeRequest(request, response) {
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(request));
    response.end();
    return;
  }

  const url = new URL(request.url, "http://localhost");
  try {
    if (request.method === "GET" && url.pathname === "/api/stripe/config") {
      handlePublicConfiguration(request, response);
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/stripe/connection"
    ) {
      await handleConnection(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/stripe/prices") {
      await handlePrices(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/stripe/shield-products") {
      await handleShieldProducts(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/stripe/shield/status") {
      handleShieldStatus(request, response, url);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/stripe/shield/player-status") {
      handlePlayerShieldStatus(request, response, url);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/stripe/shield/free") {
      await handleFreeShield(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/stripe/shield/checkout") {
      await handleShieldCheckout(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/stripe/shield/confirm") {
      await handleShieldConfirmation(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/stripe/checkout") {
      await handleCheckout(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/stripe/webhook") {
      await handleWebhook(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/stripe/return") {
      handleCheckoutReturn(request, response, url.searchParams.get("result"));
      return;
    }
    const sessionMatch = url.pathname.match(
      /^\/api\/stripe\/session\/(cs_(?:test|live)_[A-Za-z0-9]+)$/,
    );
    if (request.method === "GET" && sessionMatch) {
      await handleSession(request, response, sessionMatch[1]);
      return;
    }
    sendJson(response, request, 404, { error: "Endpoint no encontrado" });
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    console.error("[Stripe API]", error.message);
    sendJson(response, request, statusCode, {
      error:
        statusCode >= 500
          ? "No se pudo completar la operacion con Stripe"
          : error.message,
    });
  }
}

function startStripeApi(port = Number(process.env.STRIPE_PORT || DEFAULT_PORT)) {
  const server = http.createServer((request, response) => {
    void handleStripeRequest(request, response);
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`Stripe API disponible en http://localhost:${port}/api/stripe`);
  });
  server.on("error", (error) => {
    console.error("[Stripe API] No se pudo iniciar:", error.message);
  });
  return server;
}

if (require.main === module) startStripeApi();

module.exports = {
  activateShieldFromCheckoutSession,
  buildCheckoutIdempotencyKey,
  findShieldProduct,
  handleStripeRequest,
  normalizeCurrency,
  parseAllowedPriceIds,
  startStripeApi,
};
