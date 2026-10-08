const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const panel = readFileSync("src/components/territory-shield-panel.tsx", "utf8");
const profile = readFileSync("src/app/profile.tsx", "utf8");
const service = readFileSync("src/services/biometric-auth.ts", "utf8");
const appConfig = readFileSync("app.json", "utf8");
const packageJson = readFileSync("package.json", "utf8");

const claimFreeSection = panel.slice(
  panel.indexOf("const claimFree"),
  panel.indexOf("const payForShield"),
);
const paidSection = panel.slice(panel.indexOf("const payForShield"));

test("1. la integración oficial está instalada y configurada para la APK", () => {
  assert.match(packageJson, /"expo-local-authentication"/);
  assert.match(appConfig, /"expo-local-authentication"/);
});

test("2. solo se usa la autenticación local segura del sistema", () => {
  assert.match(service, /LocalAuthentication\.authenticateAsync/);
  assert.doesNotMatch(service, /Camera|fetch\(|axios|WebSocket/);
});

test("3. la preferencia queda activada por defecto cuando está disponible", () => {
  assert.match(service, /enabled: available && \(storedPreference \?\? true\)/);
});

test("4. permite el PIN o patrón administrado por el sistema", () => {
  assert.match(service, /disableDeviceFallback: false/);
  assert.match(service, /fallbackLabel: "Usar PIN o patrón"/);
});

test("5. autentica antes de crear la referencia o sesión de Stripe", () => {
  const authentication = paidSection.indexOf("authenticateShieldPurchase()");
  const purchaseReference = paidSection.indexOf("const purchaseReference");
  const checkout = paidSection.indexOf("createShieldCheckout");
  assert.ok(authentication >= 0 && authentication < purchaseReference);
  assert.ok(purchaseReference < checkout);
});

test("6. cancelar la autenticación detiene la compra sin registro pendiente", () => {
  const canceledBranch = paidSection.slice(
    paidSection.indexOf("if (!authentication.continueToPayment)"),
    paidSection.indexOf("const purchaseReference"),
  );
  assert.match(canceledBranch, /Compra cancelada/);
  assert.match(canceledBranch, /return;/);
  assert.doesNotMatch(canceledBranch, /saveShieldPurchaseRecord|createShieldCheckout/);
});

test("7. si la biometría no está disponible se avisa y se permite pagar", () => {
  assert.match(service, /continueToPayment: true, reason: "unavailable"/);
  assert.match(paidSection, /Confirmación biométrica no disponible/);
});

test("8. el escudo gratuito no solicita biometría", () => {
  assert.match(claimFreeSection, /claimFreeTerritoryShield/);
  assert.doesNotMatch(claimFreeSection, /authenticateShieldPurchase/);
});

test("9. se bloquean pulsaciones y sesiones de pago simultáneas", () => {
  assert.match(panel, /paymentInProgressRef\.current \|\| busy !== null/);
  assert.match(panel, /paymentInProgressRef\.current = true/);
  assert.match(panel, /paymentInProgressRef\.current = false/);
});

test("10. el backend confirma Stripe antes de activar el escudo", () => {
  const verify = paidSection.indexOf("getStripeCheckoutSession");
  const confirm = paidSection.indexOf("confirmShieldCheckout");
  const activate = paidSection.indexOf("applyShield(confirmed.shield)");
  assert.ok(verify >= 0 && verify < confirm);
  assert.ok(confirm < activate);
  assert.match(profile, /Confirmar compras con huella o rostro/);
});

test("11. una autenticación aprobada autoriza continuar hacia Stripe", () => {
  assert.match(
    service,
    /if \(result\.success\)[\s\S]*?continueToPayment: true, reason: "authenticated"/,
  );
  assert.match(paidSection, /Identidad confirmada/);
  assert.match(paidSection, /Abriendo pago seguro/);
});

test("12. un pago rechazado no llega a confirmar ni activar el escudo", () => {
  const rejectedBranch = paidSection.slice(
    paidSection.indexOf('if (verified.payment_status !== "paid"'),
    paidSection.indexOf("const confirmed = await confirmShieldCheckout"),
  );
  assert.match(rejectedBranch, /No se pudo completar el pago/);
  assert.match(rejectedBranch, /return;/);
  assert.doesNotMatch(rejectedBranch, /applyShield/);
});

test("13. con la configuración desactivada la compra puede ir directo a Stripe", () => {
  assert.match(
    service,
    /if \(!settings\.enabled\)[\s\S]*?continueToPayment: true, reason: "disabled"/,
  );
  assert.match(profile, /setBiometricPurchaseEnabled/);
});

test("14. comprar un escudo no exige tener territorio", () => {
  assert.match(paidSection, /const territoryId = selected\?\.id \?\? null/);
  assert.doesNotMatch(paidSection.slice(0, paidSection.indexOf("if (!systemStatus.online)")), /if \(!selected\)/);
  assert.match(paidSection, /El escudo quedará guardado para activarlo cuando conquistes un territorio/);
});

test("15. una compra sin territorio se conserva en el inventario", () => {
  assert.match(paidSection, /confirmed\.purchased_shield/);
  assert.match(panel, /Escudos comprados/);
  assert.match(panel, /Guardado hasta conquistar un territorio/);
});

test("16. el inventario puede activarse después en un territorio propio", () => {
  assert.match(panel, /activatePurchasedTerritoryShield/);
  assert.match(panel, /Escudo comprado activado/);
  assert.match(panel, /selected \? "ACTIVAR" : "GUARDADO"/);
});

test("17. los cinco botones de compra permanecen presionables sin territorio", () => {
  assert.match(panel, /DEFAULT_SHIELD_PRODUCTS/);
  assert.match(panel, /disabled=\{busy !== null\}/);
  assert.doesNotMatch(panel, /disabled=\{!product\.configured/);
  assert.doesNotMatch(paidSection, /if \(!product\.configured\) return/);
  assert.match(panel, />\s*COMPRAR\s*</);
  assert.match(panel, /loadingProducts && <ActivityIndicator/);
  assert.doesNotMatch(panel, /setBusy\("loading"\)/);
});
