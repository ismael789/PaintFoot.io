const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCheckoutIdempotencyKey,
  findShieldProduct,
  handleStripeRequest,
  normalizeCurrency,
  parseAllowedPriceIds,
} = require("../stripe-api");

function requestJson(path) {
  return new Promise((resolve) => {
    const request = { method: "GET", url: path, headers: {} };
    const response = {
      statusCode: 0,
      writeHead(statusCode) { this.statusCode = statusCode; },
      end(body) { resolve({ statusCode: this.statusCode, body: JSON.parse(body) }); },
    };
    void handleStripeRequest(request, response);
  });
}

test("Stripe normaliza la moneda configurada", () => {
  assert.equal(normalizeCurrency(" MXN "), "mxn");
  assert.throws(() => normalizeCurrency("pesos"));
});

test("Stripe habilita escudos con importe del servidor aunque no haya Price ID", () => {
  const previousPrice = process.env.STRIPE_SHIELD_6H_PRICE_ID;
  const previousAmount = process.env.STRIPE_DEFAULT_AMOUNT_CENTS;
  process.env.STRIPE_SHIELD_6H_PRICE_ID = "";
  process.env.STRIPE_DEFAULT_AMOUNT_CENTS = "1000";
  try {
    const product = findShieldProduct("shield_6h");
    assert.equal(product.priceId, null);
    assert.equal(product.inlineUnitAmount, 1000);
  } finally {
    if (previousPrice === undefined) delete process.env.STRIPE_SHIELD_6H_PRICE_ID;
    else process.env.STRIPE_SHIELD_6H_PRICE_ID = previousPrice;
    if (previousAmount === undefined) delete process.env.STRIPE_DEFAULT_AMOUNT_CENTS;
    else process.env.STRIPE_DEFAULT_AMOUNT_CENTS = previousAmount;
  }
});

test("la API entrega activos los cinco botones de compra con el importe alternativo", async () => {
  const result = await requestJson("/api/stripe/shield-products");
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.products.length, 5);
  assert.equal(result.body.products.every((product) => product.configured), true);
  assert.equal(result.body.products.every((product) => product.unit_amount > 0), true);
});

test("Stripe acepta solamente identificadores price validos", () => {
  assert.deepEqual(
    [...parseAllowedPriceIds("price_ABC123, invalido, price_XYZ789")],
    ["price_ABC123", "price_XYZ789"],
  );
});

test("Stripe genera idempotencia estable sin base de datos", () => {
  const first = buildCheckoutIdempotencyKey("orden_10", "price_ABC123", 1);
  const repeated = buildCheckoutIdempotencyKey(
    "orden_10",
    "price_ABC123",
    1,
  );
  const another = buildCheckoutIdempotencyKey("orden_11", "price_ABC123", 1);
  assert.equal(first, repeated);
  assert.notEqual(first, another);
  assert.match(first, /^paintfoot_checkout_[a-f0-9]{64}$/);
});
