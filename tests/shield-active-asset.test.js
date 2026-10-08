const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const test = require("node:test");

const panel = readFileSync("src/components/territory-shield-panel.tsx", "utf8");
const activeAsset = "escudo-territorio-activado al 100%.gif";

test("el GIF nuevo existe y reemplaza completamente al PNG anterior", () => {
  assert.equal(existsSync(activeAsset), true);
  assert.doesNotMatch(panel, /escudo-territorio-protegido\.png/);
});

test("el estado activo al 100 por ciento usa el GIF animado", () => {
  assert.match(
    panel,
    /active: require\("\.\.\/\.\.\/escudo-territorio-activado al 100%\.gif"\)/,
  );
});

test("mapa, protección y pagos comparten el recurso centralizado", () => {
  const uses = panel.match(/source=\{SHIELD_ASSETS\[indicator\.state\]\}/g) ?? [];
  assert.equal(uses.length, 2);
  assert.match(panel, /displayMode === "payments"/);
  assert.match(panel, /style=\{\[styles\.mapBadge,/);
});

test("el GIF conserva proporción y reproducción automática", () => {
  assert.match(panel, /contentFit="contain"[\s\S]*?autoplay/);
});

test("el escudo del mapa usa el tamaño visual ampliado", () => {
  assert.match(panel, /mapBadge: \{[^}]*left: 0[^}]*width: 136, height: 136/);
  assert.match(panel, /badgeImage: \{ width: 128, height: 128 \}/);
});

test("el escudo del mapa no tiene un contenedor visual de fondo", () => {
  const mapBadgeStyle = panel.match(/mapBadge: \{([^}]*)\}/)?.[1] ?? "";
  assert.doesNotMatch(mapBadgeStyle, /backgroundColor|padding|borderRadius|elevation/);
});

test("los estados agotándose y agotado conservan sus recursos", () => {
  assert.match(panel, /warning: require\("\.\.\/\.\.\/escudo-territorio-agotandose segunda parte\.png"\)/);
  assert.match(panel, /exhausted: require\("\.\.\/\.\.\/escudo-territorio-agotado 3er parte\.png"\)/);
});
