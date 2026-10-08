const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const panel = readFileSync("src/components/territory-shield-panel.tsx", "utf8");
const menuStart = panel.indexOf("visible={mapMenuVisible}");
const guideStart = panel.indexOf("visible={shieldStatesVisible}");
const menuSource = panel.slice(menuStart, guideStart);

test("el mapa conserva el menú hamburguesa arriba a la derecha", () => {
  assert.match(panel, /accessibilityLabel="Abrir menú del mapa"/);
  assert.match(panel, /mapMenuButton: \{[^}]*right: 16/);
  assert.match(panel, /top: Math\.max\(104, insets\.top \+ 78\)/);
  assert.equal((panel.match(/style=\{\[styles\.hamburgerLine/g) ?? []).length, 3);
});

test("el menú muestra solamente el icono y el texto Escudo", () => {
  assert.match(menuSource, /name=\{\{ ios: "shield\.fill", android: "shield" \}\}/);
  assert.match(menuSource, />Escudo<\/Text>/);
  assert.doesNotMatch(menuSource, /formatShieldRemainingTime|remainingMs|mapMenuOptionStatus/);
  assert.doesNotMatch(menuSource, /Disponible|Activo|Agotándose|Agotado|%/);
});

test("presionar Escudo abre el panel Estados del escudo", () => {
  assert.match(
    menuSource,
    /setMapMenuVisible\(false\);[\s\S]*?setShieldStatesVisible\(true\)/,
  );
  assert.match(panel, /visible=\{shieldStatesVisible\}/);
  assert.match(panel, /Estados del escudo/);
});

test("la guía muestra Activo 100% con el GIF correcto", () => {
  assert.match(
    panel,
    /id: "active",[\s\S]*?label: "Activo 100%",[\s\S]*?require\("\.\.\/\.\.\/escudo-territorio-activado al 100%\.gif"\)/,
  );
  assert.match(panel, /state\.id === "active" && styles\.shieldGuideActiveImage/);
  assert.match(panel, /shieldGuideImageFrame: \{ width: 140, height: 140,[^}]*justifyContent: "flex-end"/);
  assert.match(panel, /shieldGuideActiveImage: \{ width: 140, height: 140, transform: \[\{ translateY: 32 \}\] \}/);
  assert.match(panel, /shieldGuideImage: \{ width: 108, height: 108 \}/);
});

test("la guía muestra Agotándose con el GIF de primera etapa", () => {
  assert.match(
    panel,
    /id: "depleting",[\s\S]*?label: "Agotándose",[\s\S]*?require\("\.\.\/\.\.\/escudo-territorio-agotandose primera parte\.gif"\)/,
  );
});

test("la guía muestra Última etapa con el PNG de segunda etapa", () => {
  assert.match(
    panel,
    /id: "last-stage",[\s\S]*?label: "Última etapa",[\s\S]*?require\("\.\.\/\.\.\/escudo-territorio-agotandose segunda parte\.png"\)/,
  );
});

test("la guía muestra Agotado con el PNG final", () => {
  assert.match(
    panel,
    /id: "exhausted",[\s\S]*?label: "Agotado",[\s\S]*?require\("\.\.\/\.\.\/escudo-territorio-agotado 3er parte\.png"\)/,
  );
});

test("la guía es visual y el escudo actual del mapa conserva su estado dinámico", () => {
  assert.match(panel, /SHIELD_STATE_GUIDE\.map\(\(state\) =>/);
  assert.match(panel, /source=\{state\.source\}/);
  assert.match(panel, /source=\{SHIELD_ASSETS\[indicator\.state\]\}/);
  assert.match(panel, /contentFit="contain"[\s\S]*?autoplay/);
});

test("Ir a protección cierra la guía y abre el panel real existente", () => {
  assert.match(panel, /setShieldStatesVisible\(false\);[\s\S]*?openOptions\(\)/);
  assert.match(panel, /IR A PROTECCIÓN/);
  assert.match(panel, /visible=\{optionsVisible\}/);
});

test("tocar fuera cierra la guía y tocar dentro no la descarta", () => {
  assert.match(
    panel,
    /style=\{styles\.shieldGuideBackdrop\}[\s\S]*?onPress=\{\(\) => setShieldStatesVisible\(false\)\}/,
  );
  assert.match(panel, /onPress=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(panel, /accessibilityLabel="Cerrar estados del escudo tocando fuera"/);
});

test("el menú ofrece compra, inventario e historial de escudos", () => {
  assert.match(panel, /accessibilityLabel="Comprar escudos"/);
  assert.match(panel, /accessibilityLabel="Inventario de escudos"/);
  assert.match(panel, /accessibilityLabel="Historial de escudos comprados"/);
  assert.match(panel, /Inventario \(\{purchasedShields\.length\}\)/);
  assert.match(menuSource, /android: "payments"/);
  assert.match(menuSource, /android: "inventory_2"/);
  assert.match(menuSource, /android: "history"/);
  assert.doesNotMatch(menuSource, /mapMenuOptionIcon|mapMenuShieldImage/);
});

test("Comprar escudos abre directamente el panel de pago", () => {
  assert.match(
    panel,
    /accessibilityLabel="Comprar escudos"[\s\S]*?setMapMenuVisible\(false\);[\s\S]*?openOptions\(\)/,
  );
});

test("Inventario e Historial tienen panel propio y cierre exterior", () => {
  assert.match(panel, /visible=\{inventoryVisible\}/);
  assert.match(panel, /Inventario de escudos/);
  assert.match(panel, /visible=\{historyVisible\}/);
  assert.match(panel, /Historial de escudos/);
  assert.match(panel, /onPress=\{\(\) => setInventoryVisible\(false\)\}/);
  assert.match(panel, /onPress=\{\(\) => setHistoryVisible\(false\)\}/);
  assert.doesNotMatch(panel, /Historial de protección/);
});
