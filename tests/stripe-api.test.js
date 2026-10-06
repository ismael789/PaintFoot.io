const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCheckoutIdempotencyKey,
  normalizeCurrency,
  parseAllowedPriceIds,
} = require("../stripe-api");

test("Stripe normaliza la moneda configurada", () => {
  assert.equal(normalizeCurrency(" MXN "), "mxn");
  assert.throws(() => normalizeCurrency("pesos"));
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
