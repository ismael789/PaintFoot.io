const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");
const source = read("src", "services", "map-html.ts");
const appSource = read("src", "app", "index.tsx");
const syncSource = read("src", "services", "offline-sync.ts");
const feedback = read("src", "components", "global-feedback.tsx");

test("mapa: el recorrido activo sigue siendo una linea sin relleno", () => {
  assert.match(source, /L\.polyline\(\[\], \{ color: userColor, weight: 5 \}\)/);
  assert.match(source, /routeLayer\.setStyle\(\{ color: userColor \}\)/);
  assert.match(source, /route\.setAttribute\('fill', 'none'\)/);
});

test("mapa: un territorio confirmado usa borde y relleno semitransparente", () => {
  assert.match(source, /fillColor: color \|\| '#208AEF'/);
  assert.match(source, /fillOpacity: pending \? 0 : \(disputed \? 0\.14 : 0\.30\)/);
  assert.match(source, /weight: 4/);
  assert.match(source, /item\.polygon\?\.coordinates\?\.\[0\]/);
});

test("mapa offline: los territorios persistidos conservan color y transparencia", () => {
  assert.match(source, /polygon\.setAttribute\('fill', item\.playerColor \|\| item\.color/);
  assert.match(source, /polygon\.setAttribute\('fill-opacity', pending \? '0' : '0\.28'\)/);
});

test("mapa offline: usa feedback global sin advertencias tecnicas", () => {
  assert.match(syncSource, /Sin conexión · guardando recorrido local/);
  assert.match(syncSource, /Internet disponible · sincronizando/);
  assert.match(syncSource, /Sincronizado/);
  assert.match(feedback, /pointerEvents="none"/);
  assert.doesNotMatch(appSource, /territoryNotice|offlineBadge|syncBadge/);
  assert.doesNotMatch(appSource, /\[ROAD\] No se pudo ajustar/);
});
