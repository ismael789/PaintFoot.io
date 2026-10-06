const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.join(process.cwd(), "src", "services", "map-html.ts"),
  "utf8",
);

test("mapa: el recorrido activo sigue siendo una linea sin relleno", () => {
  assert.match(source, /L\.polyline\(\[\], \{ color: '#FF4444', weight: 5 \}\)/);
  assert.match(source, /route\.setAttribute\('fill', 'none'\)/);
});

test("mapa: un territorio confirmado usa borde y relleno semitransparente", () => {
  assert.match(source, /fillColor: color \|\| '#208AEF'/);
  assert.match(source, /fillOpacity: 0\.30/);
  assert.match(source, /weight: 4/);
  assert.match(source, /item\.polygon\?\.coordinates\?\.\[0\]/);
});

test("mapa offline: los territorios persistidos conservan color y transparencia", () => {
  assert.match(source, /polygon\.setAttribute\('fill', item\.playerColor \|\| item\.color/);
  assert.match(source, /polygon\.setAttribute\('fill-opacity', '0\.28'\)/);
});
