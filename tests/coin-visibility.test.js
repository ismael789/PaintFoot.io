const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const mapHtml = read("src/services/map-html.ts");
const home = read("src/app/index.tsx");
const coins = read("src/services/coins.ts");

test("monedas visibles: el catalogo local se envia al mapa al abrir", () => {
  assert.match(home, /setActiveCoins\(availableCoins\)/);
  assert.match(home, /window\.setCoins/);
  assert.match(home, /vias regionales/);
});

test("monedas visibles: el panel y el limite no eliminan monedas del viewport", () => {
  assert.match(mapHtml, /const visible = insideViewport/);
  assert.match(mapHtml, /COIN_RENDER_LIMIT/);
  assert.match(mapHtml, /COIN_RENDER_RADIUS_METERS/);
  assert.match(mapHtml, /size\.y \* 0\.42/);
});

test("monedas visibles: muestra cincuenta cercanas repartidas entre calles", () => {
  assert.match(mapHtml, /userMarker\?\.getLatLng\(\) \?\? map\.getCenter\(\)/);
  assert.match(mapHtml, /visible: limitCoinsAcrossRoads\(visible, \$\{COIN_RENDER_LIMIT\}\)/);
  assert.match(mapHtml, /first\.id\.localeCompare\(second\.id\)/);
});

test("monedas visibles: existe icono CSS y pane por encima del mapa", () => {
  assert.match(mapHtml, /background: #FFD54A/);
  assert.match(mapHtml, /&#x1FA99;/);
  assert.match(mapHtml, /createPane\('coinPane'\)/);
  assert.match(mapHtml, /pane: 'coinPane'/);
});

test("monedas visibles: menos de cincuenta marcadores activa el refuerzo vial", () => {
  assert.match(home, /renderedCoins < WORLD_COIN_MINIMUM_NEARBY_VISIBLE/);
  assert.match(home, /createRegionalStreetCoins/);
  assert.match(home, /saveWorldCoinCatalog\(visibleSeed/);
  assert.match(home, /WORLD_COIN_MINIMUM_NEARBY_VISIBLE \* 6/);
  assert.match(home, /window\.setCoins/);
});

test("monedas visibles: la ubicacion GPS tiene prioridad sobre el centro desplazado del mapa", () => {
  assert.match(home, /const effectiveCoinCenter = location \?\? coinViewportCenter/);
});

test("monedas regionales: mover el viewport solicita y descarga otra zona", () => {
  assert.match(mapHtml, /coin-region-request/);
  assert.match(mapHtml, /requestCoinsForViewport/);
  assert.match(home, /setCoinViewportCenter/);
  assert.match(home, /COIN_UNLOAD_RADIUS_METERS/);
});

test("monedas visibles: el catalogo cercano se recalcula al caminar dentro de una region", () => {
  assert.match(home, /currentCoinProximityId/);
  assert.match(home, /WORLD_COIN_NEARBY_REFRESH_CELL_DEGREES/);
  assert.match(home, /\[currentCoinProximityId, currentCoinRegionId, myPlayerId\]/);
});

test("monedas visibles: Supabase no bloquea el primer render local", () => {
  assert.match(coins, /void reconcileUnavailableGlobalCoins\(client, available\)/);
  assert.match(coins, /return available/);
});
