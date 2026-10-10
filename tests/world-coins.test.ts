import assert from "node:assert/strict";
import test from "node:test";

import {
  balanceCoinCatalogByRoad,
  createCityStreetCoinCatalog,
  createCoinsForMissingRoadSegments,
  createCoinsForMissingRoadSegmentsInBounds,
  createVisibleRoadCoinSeed,
  createWorldStreetCoins,
  createRegionalStreetCoins,
  coinsWithinRenderRadius,
  COIN_DENSITY_VERSION,
  COIN_LOAD_RADIUS_METERS,
  COIN_MIN_DISTANCE_METERS,
  COIN_MIN_PER_STREET,
  COIN_RENDER_RADIUS_METERS,
  COIN_SPAWN_INTERVAL_METERS,
  SAN_LUIS_RIO_COLORADO_COIN_TARGET,
  SAN_LUIS_RIO_COLORADO_DENSITY_VERSION,
  WORLD_COIN_DENSITY_VERSION,
  WORLD_COIN_MAXIMUM,
  WORLD_COIN_MINIMUM_SEPARATION_METERS,
  WORLD_COIN_MINIMUM_NEARBY_VISIBLE,
  WORLD_COIN_RADIUS_METERS,
  WORLD_COIN_TARGET,
  WORLD_COIN_SPACING_METERS,
} from "../src/services/world-coins";
import type { GeoCoordinate, RoadSegment } from "../src/types/game";
import { distanceInMeters } from "../src/utils/geo";

const center = { latitude: 29.0729, longitude: -110.9559 };

function road(id: string, coordinates: GeoCoordinate[]): RoadSegment {
  return {
    id,
    wayId: id,
    name: `Calle ${id}`,
    coordinates,
    startNodeId: `${id}:start`,
    endNodeId: `${id}:end`,
    intersectingEdgeCount: 2,
    endNodeType: null,
  };
}

function denseStreetGrid() {
  const segments: RoadSegment[] = [];
  for (let index = -30; index <= 30; index += 1) {
    const offset = index * 0.00045;
    segments.push(
      road(`horizontal-${index}`, [
        { latitude: center.latitude + offset, longitude: center.longitude - 0.02 },
        { latitude: center.latitude + offset, longitude: center.longitude + 0.02 },
      ]),
      road(`vertical-${index}`, [
        { latitude: center.latitude - 0.02, longitude: center.longitude + offset },
        { latitude: center.latitude + 0.02, longitude: center.longitude + offset },
      ]),
    );
  }
  return segments;
}

test("genera aproximadamente mil monedas para una zona urbana", () => {
  const coins = createWorldStreetCoins(center, denseStreetGrid());
  assert.ok(coins.length >= 900, `solo se generaron ${coins.length}`);
  assert.ok(coins.length <= WORLD_COIN_MAXIMUM);
});

test("la seleccion local concentra suficientes monedas cerca del jugador", () => {
  const coins = createWorldStreetCoins(center, denseStreetGrid());
  const nearby = coins.filter(
    (coin) => distanceInMeters(coin, center) <= 400,
  );
  assert.ok(
    nearby.length >= 100,
    `solo quedaron ${nearby.length} monedas a menos de 400 metros`,
  );
});

test("las mil monedas respetan la separacion minima y no se amontonan", () => {
  const bounds = {
    south: center.latitude - 0.02,
    west: center.longitude - 0.02,
    north: center.latitude + 0.02,
    east: center.longitude + 0.02,
  };
  const coins = createCityStreetCoinCatalog(bounds, denseStreetGrid());
  assert.equal(coins.length, WORLD_COIN_TARGET);
  for (let first = 0; first < coins.length; first += 1) {
    for (let second = first + 1; second < coins.length; second += 1) {
      assert.ok(
        distanceInMeters(coins[first], coins[second]) >=
          WORLD_COIN_MINIMUM_SEPARATION_METERS - 0.25,
        `${coins[first].id} y ${coins[second].id} estan demasiado cerca`,
      );
    }
  }
});

test("la distribucion cubre diferentes sectores del mapa", () => {
  const bounds = {
    south: center.latitude - 0.02,
    west: center.longitude - 0.02,
    north: center.latitude + 0.02,
    east: center.longitude + 0.02,
  };
  const coins = createCityStreetCoinCatalog(bounds, denseStreetGrid());
  const occupiedSectors = new Set(
    coins.map((coin) =>
      `${Math.floor((coin.latitude - bounds.south) / 0.005)}:` +
      `${Math.floor((coin.longitude - bounds.west) / 0.005)}`,
    ),
  );
  assert.ok(occupiedSectors.size >= 40, `solo cubrio ${occupiedSectors.size} sectores`);
});

test("todas las monedas se mantienen sobre las calles recibidas", () => {
  const horizontalLatitude = center.latitude + 0.001;
  const coins = createWorldStreetCoins(center, [
    road("only-road", [
      { latitude: horizontalLatitude, longitude: center.longitude - 0.02 },
      { latitude: horizontalLatitude, longitude: center.longitude + 0.02 },
    ]),
  ]);
  assert.ok(coins.length > 0);
  for (const coin of coins) {
    assert.ok(Math.abs(coin.latitude - horizontalLatitude) < 0.000001);
    assert.ok(distanceInMeters(coin, center) <= WORLD_COIN_RADIUS_METERS + 1);
  }
});

test("dos jugadores con los mismos datos viales reciben IDs y posiciones iguales", () => {
  const segments = denseStreetGrid();
  const first = createWorldStreetCoins(center, segments);
  const second = createWorldStreetCoins(center, [...segments].reverse());
  assert.deepEqual(second, first);
  assert.ok(first.every((coin) => coin.id.startsWith("world-coin:")));
});

test("sin geometría vial no inventa monedas dentro de viviendas", () => {
  assert.deepEqual(createWorldStreetCoins(center, []), []);
});

test("el catálogo urbano contiene exactamente mil monedas compartidas", () => {
  const bounds = {
    south: center.latitude - 0.02,
    west: center.longitude - 0.02,
    north: center.latitude + 0.02,
    east: center.longitude + 0.02,
  };
  const segments = denseStreetGrid();
  const first = createCityStreetCoinCatalog(bounds, segments);
  const second = createCityStreetCoinCatalog(bounds, [...segments].reverse());
  assert.equal(first.length, WORLD_COIN_TARGET);
  assert.deepEqual(second, first);
  assert.equal(new Set(first.map((coin) => coin.id)).size, WORLD_COIN_TARGET);
  assert.ok(first.every((coin) =>
    coin.latitude >= bounds.south && coin.latitude <= bounds.north &&
    coin.longitude >= bounds.west && coin.longitude <= bounds.east
  ));
});

test("el fallback visible crea monedas cercanas solo desde calles reales", () => {
  const segments = denseStreetGrid();
  const coins = createVisibleRoadCoinSeed(center, segments, 40);
  assert.equal(coins.length, 40);
  assert.ok(coins.every((coin) => coin.source === "debug_visible_seed"));
  assert.ok(coins.every((coin) => coin.id.startsWith("world-coin:debug:")));
  assert.ok(coins.every((coin) => distanceInMeters(coin, center) <= WORLD_COIN_RADIUS_METERS));
  assert.deepEqual(createVisibleRoadCoinSeed(center, []), []);
});

test("veinte calles validas reciben monedas sin concentrarse en una sola avenida", () => {
  const streets = Array.from({ length: 20 }, (_, index) =>
    road(`street-${index}`, [
      {
        latitude: center.latitude + (index - 10) * 0.0004,
        longitude: center.longitude - 0.01,
      },
      {
        latitude: center.latitude + (index - 10) * 0.0004,
        longitude: center.longitude + 0.01,
      },
    ]),
  );
  const coins = createWorldStreetCoins(center, streets);
  assert.equal(new Set(coins.map((coin) => coin.roadSegmentId)).size, 20);
  assert.equal(WORLD_COIN_SPACING_METERS, 3);
});

test("una via recta coloca una moneda exactamente cada tres metros", () => {
  const street = road("three-meter-spacing", [
    { latitude: center.latitude, longitude: center.longitude },
    { latitude: center.latitude, longitude: center.longitude + 0.001 },
  ]);
  const coins = createWorldStreetCoins(center, [street]).sort(
    (first, second) => first.segmentIndex - second.segmentIndex,
  );
  assert.ok(coins.length >= 20);
  for (let index = 1; index < coins.length; index += 1) {
    assert.equal(coins[index].segmentIndex - coins[index - 1].segmentIndex, 3_000);
    const spacing = distanceInMeters(coins[index - 1], coins[index]);
    assert.ok(
      Math.abs(spacing - 3) <= 0.03,
      `se midieron ${spacing.toFixed(3)} m entre monedas`,
    );
  }
});

test("al cargar nuevas calles genera solo las que faltaban y conserva el catalogo", () => {
  const streets = Array.from({ length: 20 }, (_, index) =>
    road(`incremental-${index}`, [
      {
        latitude: center.latitude + (index - 10) * 0.0004,
        longitude: center.longitude - 0.01,
      },
      {
        latitude: center.latitude + (index - 10) * 0.0004,
        longitude: center.longitude + 0.01,
      },
    ]),
  );
  const existing = createWorldStreetCoins(center, streets.slice(0, 10));
  const missing = createCoinsForMissingRoadSegments(center, streets, existing);
  assert.ok(missing.length > 0);
  assert.ok(missing.every((coin) => Number(coin.roadSegmentId.split("-").at(-1)) >= 10));

  const merged = balanceCoinCatalogByRoad([...existing, ...missing]);
  assert.equal(new Set(merged.map((coin) => coin.roadSegmentId)).size, 20);
  assert.equal(new Set(merged.map((coin) => coin.id)).size, merged.length);
  assert.deepEqual(
    createCoinsForMissingRoadSegments(center, streets, merged),
    [],
  );
});

test("reiniciar con las mismas calles mantiene posiciones e IDs estables", () => {
  const streets = denseStreetGrid();
  const firstLoad = createCityStreetCoinCatalog({
    south: center.latitude - 0.02,
    west: center.longitude - 0.02,
    north: center.latitude + 0.02,
    east: center.longitude + 0.02,
  }, streets);
  const reopened = createCityStreetCoinCatalog({
    south: center.latitude - 0.02,
    west: center.longitude - 0.02,
    north: center.latitude + 0.02,
    east: center.longitude + 0.02,
  }, [...streets].reverse());
  assert.deepEqual(reopened, firstLoad);
});

test("el limite del catalogo toma una moneda de cada calle antes de repetir", () => {
  const streets = Array.from({ length: 3 }, (_, index) =>
    road(`visible-${index}`, [
      {
        latitude: center.latitude + (index - 1) * 0.0004,
        longitude: center.longitude - 0.01,
      },
      {
        latitude: center.latitude + (index - 1) * 0.0004,
        longitude: center.longitude + 0.01,
      },
    ]),
  );
  const visible = balanceCoinCatalogByRoad(
    createWorldStreetCoins(center, streets),
    3,
  );
  assert.equal(visible.length, 3);
  assert.equal(new Set(visible.map((coin) => coin.roadSegmentId)).size, 3);
});

test("una calle larga recibe muchas monedas con la nueva densidad", () => {
  const coins = createWorldStreetCoins(center, [
    road("long-dense-road", [
      { latitude: center.latitude, longitude: center.longitude - 0.01 },
      { latitude: center.latitude, longitude: center.longitude + 0.01 },
    ]),
  ]);
  assert.ok(coins.length >= 100, `solo se generaron ${coins.length}`);
  assert.ok(coins.every((coin) => coin.densityVersion === WORLD_COIN_DENSITY_VERSION));
});

test("la densidad anterior agrega posiciones faltantes sin duplicar las guardadas", () => {
  const street = road("density-upgrade", [
    { latitude: center.latitude, longitude: center.longitude - 0.01 },
    { latitude: center.latitude, longitude: center.longitude + 0.01 },
  ]);
  const dense = createWorldStreetCoins(center, [street]);
  const oldDensity = dense
    .filter((_, index) => index % 2 === 0)
    .map((coin) => ({ ...coin, densityVersion: 1 }));
  const missing = createCoinsForMissingRoadSegments(center, [street], oldDensity);
  assert.ok(missing.length > 0);
  assert.ok(missing.every((coin) => coin.densityVersion === WORLD_COIN_DENSITY_VERSION));
  const oldIds = new Set(oldDensity.map((coin) => coin.id));
  assert.ok(missing.every((coin) => !oldIds.has(coin.id)));
});

test("una zona vial suficiente ofrece al menos cincuenta monedas visibles", () => {
  const visible = createVisibleRoadCoinSeed(center, denseStreetGrid());
  assert.equal(WORLD_COIN_MINIMUM_NEARBY_VISIBLE, 50);
  assert.ok(visible.length >= WORLD_COIN_MINIMUM_NEARBY_VISIBLE);
  assert.ok(
    visible.filter((coin) => distanceInMeters(coin, center) <= 600).length >=
      WORLD_COIN_MINIMUM_NEARBY_VISIBLE,
    "las posiciones seleccionadas quedaron demasiado lejos del jugador",
  );
});

test("San Luis Rio Colorado mantiene tres mil monedas urbanas", () => {
  const bounds = {
    south: center.latitude - 0.02,
    west: center.longitude - 0.02,
    north: center.latitude + 0.02,
    east: center.longitude + 0.02,
  };
  const coins = createCoinsForMissingRoadSegmentsInBounds(
    bounds,
    denseStreetGrid(),
    [],
    SAN_LUIS_RIO_COLORADO_COIN_TARGET,
    SAN_LUIS_RIO_COLORADO_DENSITY_VERSION,
  );
  assert.equal(coins.length, 3_000);
  assert.ok(
    coins.every(
      (coin) => coin.densityVersion === SAN_LUIS_RIO_COLORADO_DENSITY_VERSION,
    ),
  );
});

test("regional 1: una via valida recibe al menos cinco monedas", () => {
  const street = road("regional-valid", [
    { latitude: center.latitude, longitude: center.longitude - 0.0006 },
    { latitude: center.latitude, longitude: center.longitude + 0.0006 },
  ]);
  const coins = createRegionalStreetCoins(center, [street]);
  assert.ok(coins.length >= COIN_MIN_PER_STREET);
  assert.ok(coins.every((coin) => coin.roadSegmentId === street.id));
});

test("regional 2: cada via cargada recibe monedas", () => {
  const streets = [-2, -1, 0, 1, 2].map((offset) => road(`regional-${offset}`, [
    { latitude: center.latitude + offset * 0.0002, longitude: center.longitude - 0.0006 },
    { latitude: center.latitude + offset * 0.0002, longitude: center.longitude + 0.0006 },
  ]));
  const coins = createRegionalStreetCoins(center, streets);
  for (const street of streets) {
    assert.ok(
      coins.filter((coin) => coin.roadSegmentId === street.id).length >=
        COIN_MIN_PER_STREET,
    );
  }
});

test("regional 3: una via larga recibe mas de cinco monedas", () => {
  const street = road("regional-long", [
    { latitude: center.latitude, longitude: center.longitude - 0.003 },
    { latitude: center.latitude, longitude: center.longitude + 0.003 },
  ]);
  const coins = createRegionalStreetCoins(center, [street]);
  assert.ok(coins.length > COIN_MIN_PER_STREET);
  assert.ok(coins.length >= Math.floor(500 / COIN_SPAWN_INTERVAL_METERS));
});

test("regional 4: una via corta no encime monedas", () => {
  const street = road("regional-short", [
    { latitude: center.latitude, longitude: center.longitude },
    { latitude: center.latitude, longitude: center.longitude + 0.00035 },
  ]);
  const coins = createRegionalStreetCoins(center, [street])
    .sort((a, b) => a.segmentIndex - b.segmentIndex);
  assert.ok(coins.length < COIN_MIN_PER_STREET);
  for (let index = 1; index < coins.length; index += 1) {
    assert.ok(
      distanceInMeters(coins[index - 1], coins[index]) >=
        COIN_MIN_DISTANCE_METERS - 0.1,
    );
  }
});

test("regional 5: monedas lejanas quedan fuera del render", () => {
  const coins = createRegionalStreetCoins(center, denseStreetGrid());
  const visible = coinsWithinRenderRadius(center, coins);
  assert.ok(visible.length > 0);
  assert.ok(visible.every(
    (coin) => distanceInMeters(coin, center) <= COIN_RENDER_RADIUS_METERS,
  ));
});

test("regional 6 y 7: acercarse carga una zona y alejarse la descarga", () => {
  const nearRoad = road("near-zone", [
    { latitude: center.latitude, longitude: center.longitude - 0.001 },
    { latitude: center.latitude, longitude: center.longitude + 0.001 },
  ]);
  const farCenter = { latitude: center.latitude + 0.02, longitude: center.longitude };
  const farRoad = road("far-zone", [
    { latitude: farCenter.latitude, longitude: farCenter.longitude - 0.001 },
    { latitude: farCenter.latitude, longitude: farCenter.longitude + 0.001 },
  ]);
  const near = createRegionalStreetCoins(center, [nearRoad, farRoad]);
  const far = createRegionalStreetCoins(farCenter, [nearRoad, farRoad]);
  assert.ok(near.some((coin) => coin.roadSegmentId === nearRoad.id));
  assert.ok(near.every((coin) => coin.roadSegmentId !== farRoad.id));
  assert.ok(far.some((coin) => coin.roadSegmentId === farRoad.id));
  assert.ok(far.every((coin) => coin.roadSegmentId !== nearRoad.id));
});

test("regional 8: reabrir conserva IDs, posiciones y version", () => {
  const streets = denseStreetGrid();
  const first = createRegionalStreetCoins(center, streets);
  const reopened = createRegionalStreetCoins(center, [...streets].reverse());
  assert.deepEqual(reopened, first);
  assert.ok(first.every((coin) => coin.densityVersion === COIN_DENSITY_VERSION));
});

test("regional 9: offline sin geometria no inventa monedas", () => {
  assert.deepEqual(createRegionalStreetCoins(center, []), []);
});

test("regional 10: la generacion se limita al radio cargado", () => {
  const coins = createRegionalStreetCoins(center, denseStreetGrid());
  assert.ok(coins.length > 0);
  assert.ok(coins.every(
    (coin) => distanceInMeters(coin, center) <= COIN_LOAD_RADIUS_METERS,
  ));
});
