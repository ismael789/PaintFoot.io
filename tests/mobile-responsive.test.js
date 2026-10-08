const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("las pantallas desplazables respetan area segura y limitan su ancho", () => {
  for (const file of ["src/app/payments.tsx", "src/app/explore.tsx", "src/app/profile.tsx"]) {
    const source = read(file);
    assert.match(source, /useSafeAreaInsets/);
    assert.match(source, /<ScrollView/);
    assert.match(source, /maxWidth:\s*7[0-9]{2}/);
    assert.match(source, /alignSelf:\s*"center"/);
  }
});

test("los componentes moviles reaccionan al ancho, alto y escala de fuente", () => {
  for (const file of [
    "src/app/index.tsx",
    "src/app/explore.tsx",
    "src/app/profile.tsx",
    "src/components/territory-shield-panel.tsx",
    "src/components/offline-simulation-screen.tsx",
    "src/components/animated-icon.tsx",
  ]) {
    assert.match(read(file), /useWindowDimensions/);
  }
});

test("el mapa y los paneles del escudo no quedan cortados en pantallas pequenas", () => {
  const map = read("src/app/index.tsx");
  const shields = read("src/components/territory-shield-panel.tsx");

  assert.match(map, /styles\.controlPanelContentCompact/);
  assert.match(map, /maxHeight:\s*Math\.max\(210, height \* 0\.48\)/);
  assert.match(map, /showsVerticalScrollIndicator=\{false\}/);
  assert.match(shields, /shieldGuideStateCompact/);
  assert.match(shields, /productActionColumnCompact/);
  assert.match(shields, /modalMaxHeight/);
  assert.match(shields, /contentContainerStyle=\{styles\.mapMenuCardContent\}/);
});

test("la animacion movil ya no conserva dimensiones tomadas solo al arrancar", () => {
  const source = read("src/components/animated-icon.tsx");
  assert.doesNotMatch(source, /Dimensions\.get\(/);
  assert.match(source, /Math\.min\(128, width \* 0\.34\)/);
});
