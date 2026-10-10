import type { GeoCoordinate, RoadSegment } from "../types/game";
import { distanceInMeters } from "../utils/geo";

export interface WorldCoin extends GeoCoordinate {
  id: string;
  value: number;
  regionId: string;
  roadSegmentId: string;
  segmentIndex: number;
  densityVersion: number;
  source: "osm_road" | "debug_visible_seed";
  hash: string;
}

interface RoadCoinCandidate extends GeoCoordinate {
  roadSegmentId: string;
  segmentIndex: number;
}

export const WORLD_COIN_TARGET = 3_000;
export const WORLD_COIN_MAXIMUM = 3_000;
export const SAN_LUIS_RIO_COLORADO_COIN_TARGET = 3_000;
export const SAN_LUIS_RIO_COLORADO_DENSITY_VERSION = 5;
export const WORLD_COIN_ACTIVE_CATALOG_LIMIT = 3_000;
export const WORLD_COIN_NEARBY_TARGET = 1_500;
// El mapa puede mostrar todo el catalogo activo; el viewport sigue evitando
// crear marcadores para posiciones geograficamente fuera de pantalla.
export const WORLD_COIN_VISIBLE_LIMIT = WORLD_COIN_ACTIVE_CATALOG_LIMIT;
export const WORLD_COIN_RADIUS_METERS = 2_000;
// El mapa debe conservar un grupo util de monedas alrededor del jugador. Este
// minimo se comprueba de nuevo al desplazarse, no solamente al entrar a una
// region de varios kilometros.
export const WORLD_COIN_MINIMUM_NEARBY_VISIBLE = 50;
export const WORLD_COIN_NEARBY_REFRESH_CELL_DEGREES = 0.0015;
// La ruta recorrible se muestrea cada tres metros. La separacion tecnica es
// ligeramente menor para no descartar puntos validos por redondeo geodesico.
export const WORLD_COIN_MINIMUM_SEPARATION_METERS = 2.5;
export const WORLD_COIN_SPACING_METERS = 3;
export const WORLD_COIN_DENSITY_VERSION = 4;

// Distribucion regional vigente. Las constantes antiguas se conservan para
// poder leer catalogos previos sin mover ni borrar monedas ya publicadas.
export const COIN_DENSITY_VERSION = 7;
export const COIN_MIN_PER_STREET = 5;
export const COIN_SPAWN_INTERVAL_METERS = 20;
export const COIN_MIN_DISTANCE_METERS = 15;
export const COIN_LOAD_RADIUS_METERS = 800;
export const COIN_RENDER_RADIUS_METERS = 500;
export const COIN_UNLOAD_RADIUS_METERS = 1_200;
// Solo las cincuenta monedas cercanas mejor repartidas se muestran. El resto
// permanece en su region y aparece cuando el jugador se aproxima.
export const COIN_RENDER_LIMIT = 50;
export const COIN_ACTIVE_MEMORY_LIMIT = 5_000;

export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

const METERS_PER_LATITUDE_DEGREE = 111_320;
const CITY_REFERENCE_LATITUDE_RADIANS = (30 * Math.PI) / 180;

function localDistanceSquaredFrom(center: GeoCoordinate) {
  const longitudeMetersPerDegree =
    METERS_PER_LATITUDE_DEGREE * Math.cos((center.latitude * Math.PI) / 180);
  return (point: GeoCoordinate) => {
    const latitudeMeters =
      (point.latitude - center.latitude) * METERS_PER_LATITUDE_DEGREE;
    const longitudeMeters =
      (point.longitude - center.longitude) * longitudeMetersPerDegree;
    return latitudeMeters * latitudeMeters + longitudeMeters * longitudeMeters;
  };
}

function stableHash(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function normalizedCoordinate(value: number) {
  return Number(value.toFixed(7));
}

function coinId(point: GeoCoordinate) {
  return `world-coin:${point.latitude.toFixed(6)}:${point.longitude.toFixed(6)}`;
}

function persistentCoinRegionId(point: GeoCoordinate) {
  const latitudeCell = Math.floor((point.latitude + 90) / 0.02);
  const longitudeCell = Math.floor((point.longitude + 180) / 0.02);
  return `region_${latitudeCell}_${longitudeCell}`;
}

function worldCoin(
  point: RoadCoinCandidate,
  densityVersion = WORLD_COIN_DENSITY_VERSION,
): WorldCoin {
  const id = coinId(point);
  return {
    id,
    latitude: point.latitude,
    longitude: point.longitude,
    value: 1,
    regionId: persistentCoinRegionId(point),
    roadSegmentId: point.roadSegmentId,
    segmentIndex: point.segmentIndex,
    densityVersion,
    source: "osm_road",
    hash: stableHash(
      `${persistentCoinRegionId(point)}:${point.roadSegmentId}:${point.segmentIndex}:${densityVersion}:${id}`,
    ).toString(16).padStart(8, "0"),
  };
}

function regionalCoin(point: RoadCoinCandidate): WorldCoin {
  const regionId = persistentCoinRegionId(point);
  const roadHash = stableHash(point.roadSegmentId).toString(16).padStart(8, "0");
  const id = `world-coin:v${COIN_DENSITY_VERSION}:${regionId}:${roadHash}:${point.segmentIndex}`;
  return {
    id,
    latitude: point.latitude,
    longitude: point.longitude,
    value: 1,
    regionId,
    roadSegmentId: point.roadSegmentId,
    segmentIndex: point.segmentIndex,
    densityVersion: COIN_DENSITY_VERSION,
    source: "osm_road",
    hash: stableHash(
      `${regionId}:${point.roadSegmentId}:${COIN_DENSITY_VERSION}:${point.segmentIndex}`,
    ).toString(16).padStart(8, "0"),
  };
}

function roadLengthMeters(segment: RoadSegment) {
  let length = 0;
  for (let index = 1; index < segment.coordinates.length; index += 1) {
    length += distanceInMeters(
      segment.coordinates[index - 1],
      segment.coordinates[index],
    );
  }
  return length;
}

function pointAlongRoad(
  segment: RoadSegment,
  targetDistanceMeters: number,
): RoadCoinCandidate | null {
  let traveled = 0;
  for (let index = 1; index < segment.coordinates.length; index += 1) {
    const start = segment.coordinates[index - 1];
    const end = segment.coordinates[index];
    const length = distanceInMeters(start, end);
    if (!Number.isFinite(length) || length <= 0) continue;
    if (traveled + length >= targetDistanceMeters) {
      const ratio = Math.max(0, Math.min(1, (targetDistanceMeters - traveled) / length));
      return {
        latitude: normalizedCoordinate(
          start.latitude + (end.latitude - start.latitude) * ratio,
        ),
        longitude: normalizedCoordinate(
          start.longitude + (end.longitude - start.longitude) * ratio,
        ),
        roadSegmentId: segment.id,
        segmentIndex: Math.round(targetDistanceMeters * 1_000),
      };
    }
    traveled += length;
  }
  return null;
}

/**
 * Generates only the coin region around a player/map viewport. Every walkable
 * road receives five evenly-spaced positions when its geometry is long enough;
 * longer streets receive one position per configured interval.
 */
export function createRegionalStreetCoins(
  center: GeoCoordinate,
  segments: RoadSegment[],
  loadRadiusMeters = COIN_LOAD_RADIUS_METERS,
): WorldCoin[] {
  const coins = new Map<string, WorldCoin>();
  const sortedSegments = [...segments].sort((first, second) =>
    first.id.localeCompare(second.id),
  );
  for (const segment of sortedSegments) {
    if (!segment.id || segment.coordinates.length < 2) continue;
    const length = roadLengthMeters(segment);
    if (!Number.isFinite(length) || length < COIN_MIN_DISTANCE_METERS) continue;
    const maximumWithoutOverlap = Math.max(
      1,
      Math.floor(length / COIN_MIN_DISTANCE_METERS),
    );
    const desiredCount = maximumWithoutOverlap >= COIN_MIN_PER_STREET
      ? Math.max(COIN_MIN_PER_STREET, Math.floor(length / COIN_SPAWN_INTERVAL_METERS))
      : maximumWithoutOverlap;
    const count = Math.min(maximumWithoutOverlap, desiredCount);
    for (let index = 0; index < count; index += 1) {
      // Centrar cada intervalo deja el mismo margen en ambos extremos y nunca
      // reduce la separacion por debajo del minimo configurado.
      const distance = ((index + 0.5) / count) * length;
      const point = pointAlongRoad(segment, distance);
      if (!point || distanceInMeters(point, center) > loadRadiusMeters) continue;
      const coin = regionalCoin(point);
      coins.set(coin.id, coin);
    }
  }
  return [...coins.values()]
    .sort(
      (first, second) =>
        distanceInMeters(first, center) - distanceInMeters(second, center) ||
        first.id.localeCompare(second.id),
    )
    .slice(0, COIN_ACTIVE_MEMORY_LIMIT);
}

export function coinsWithinRenderRadius(
  center: GeoCoordinate,
  coins: WorldCoin[],
) {
  return coins.filter(
    (coin) => distanceInMeters(coin, center) <= COIN_RENDER_RADIUS_METERS,
  );
}

function pointInsideBounds(point: GeoCoordinate, bounds: GeoBounds) {
  return (
    point.latitude >= bounds.south &&
    point.latitude <= bounds.north &&
    point.longitude >= bounds.west &&
    point.longitude <= bounds.east
  );
}

function spatialBucket(point: GeoCoordinate, bucketSizeMeters: number) {
  const longitudeMeters =
    point.longitude * METERS_PER_LATITUDE_DEGREE * Math.cos(CITY_REFERENCE_LATITUDE_RADIANS);
  const latitudeMeters = point.latitude * METERS_PER_LATITUDE_DEGREE;
  return {
    x: Math.floor(longitudeMeters / bucketSizeMeters),
    y: Math.floor(latitudeMeters / bucketSizeMeters),
  };
}

function selectBalancedRoadCandidates(
  roads: Array<[string, RoadCoinCandidate[]]>,
  target: number,
  minimumSeparationMeters: number,
  reserved: GeoCoordinate[] = [],
) {
  const selected: RoadCoinCandidate[] = [];
  const selectedBuckets = new Map<string, GeoCoordinate[]>();
  const cursors = roads.map(() => 0);

  for (const point of reserved) {
    const bucket = spatialBucket(point, minimumSeparationMeters);
    const bucketId = `${bucket.x}:${bucket.y}`;
    selectedBuckets.set(bucketId, [...(selectedBuckets.get(bucketId) ?? []), point]);
  }

  const hasEnoughSeparation = (point: GeoCoordinate) => {
    const bucket = spatialBucket(point, minimumSeparationMeters);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nearby = selectedBuckets.get(`${bucket.x + offsetX}:${bucket.y + offsetY}`) ?? [];
        if (nearby.some((other) => distanceInMeters(point, other) < minimumSeparationMeters)) {
          return false;
        }
      }
    }
    return true;
  };

  while (selected.length < target) {
    let candidatesRemain = false;
    let addedThisRound = false;
    for (let roadIndex = 0; roadIndex < roads.length; roadIndex += 1) {
      const candidates = roads[roadIndex][1];
      while (cursors[roadIndex] < candidates.length) {
        candidatesRemain = true;
        const point = candidates[cursors[roadIndex]];
        cursors[roadIndex] += 1;
        if (!hasEnoughSeparation(point)) continue;
        selected.push(point);
        const bucket = spatialBucket(point, minimumSeparationMeters);
        const bucketId = `${bucket.x}:${bucket.y}`;
        selectedBuckets.set(bucketId, [...(selectedBuckets.get(bucketId) ?? []), point]);
        addedThisRound = true;
        break;
      }
      if (selected.length >= target) break;
    }
    if (!candidatesRemain || !addedThisRound) break;
  }
  return selected;
}

function sampledRoadCandidatesByRoad(
  segments: RoadSegment[],
  accepts: (point: GeoCoordinate) => boolean,
  spacingMeters = WORLD_COIN_SPACING_METERS,
) {
  const candidatesByRoad = new Map<string, Map<string, RoadCoinCandidate>>();
  const sortedSegments = [...segments].sort((first, second) => first.id.localeCompare(second.id));
  for (const segment of sortedSegments) {
    if (!segment.id || segment.coordinates.length < 2) continue;
    const roadCandidates = candidatesByRoad.get(segment.id) ?? new Map();
    let traveledMeters = 0;
    let nextCoinDistanceMeters = spacingMeters / 2;
    for (let index = 1; index < segment.coordinates.length; index += 1) {
      const start = segment.coordinates[index - 1];
      const end = segment.coordinates[index];
      const lengthMeters = distanceInMeters(start, end);
      if (!Number.isFinite(lengthMeters) || lengthMeters <= 0) continue;
      const segmentEndMeters = traveledMeters + lengthMeters;
      while (nextCoinDistanceMeters <= segmentEndMeters) {
        const candidateDistanceMeters = nextCoinDistanceMeters;
        nextCoinDistanceMeters += spacingMeters;
        const ratio = (candidateDistanceMeters - traveledMeters) / lengthMeters;
        const point = {
          latitude: normalizedCoordinate(
            start.latitude + (end.latitude - start.latitude) * ratio,
          ),
          longitude: normalizedCoordinate(
            start.longitude + (end.longitude - start.longitude) * ratio,
          ),
        };
        if (!accepts(point)) continue;
        const candidate: RoadCoinCandidate = {
          ...point,
          roadSegmentId: segment.id,
          // Milimetros recorridos desde el inicio de la via: estable entre jugadores.
          segmentIndex: Math.round(candidateDistanceMeters * 1_000),
        };
        const id = coinId(point);
        roadCandidates.set(id, candidate);
      }
      traveledMeters = segmentEndMeters;
    }
    if (roadCandidates.size > 0) candidatesByRoad.set(segment.id, roadCandidates);
  }
  return [...candidatesByRoad.entries()]
    .sort(([first], [second]) =>
      stableHash(first) - stableHash(second) || first.localeCompare(second),
    )
    .map(([roadId, candidates]) => [
      roadId,
      [...candidates.values()].sort((first, second) => {
        const firstId = coinId(first);
        const secondId = coinId(second);
        return stableHash(firstId) - stableHash(secondId) || firstId.localeCompare(secondId);
      }),
    ] as [string, RoadCoinCandidate[]]);
}

function prioritizeRoadCandidatesNear(
  roads: Array<[string, RoadCoinCandidate[]]>,
  center: GeoCoordinate,
) {
  const distanceSquared = localDistanceSquaredFrom(center);
  return roads.map(([roadId, candidates]) => [
    roadId,
    [...candidates].sort(
      (first, second) =>
        distanceSquared(first) - distanceSquared(second) ||
        coinId(first).localeCompare(coinId(second)),
    ),
  ] as [string, RoadCoinCandidate[]]);
}

/**
 * Keeps coins useful at walking zoom. A small first pass covers different
 * nearby roads; the remaining budget is filled with the closest real road
 * positions instead of being exhausted by one point on every road in a city.
 */
function selectNearbyRoadCandidates(
  roads: Array<[string, RoadCoinCandidate[]]>,
  center: GeoCoordinate,
  target: number,
  minimumSeparationMeters: number,
  reserved: GeoCoordinate[] = [],
) {
  const distanceSquared = localDistanceSquaredFrom(center);
  const roadsByDistance = [...roads].sort(
    ([firstId, first], [secondId, second]) =>
      distanceSquared(first[0]) - distanceSquared(second[0]) ||
      firstId.localeCompare(secondId),
  );
  const roadCoverageTarget = Math.min(
    roadsByDistance.length,
    target,
    Math.max(1, Math.floor(target * 0.1)),
  );
  const roadCoverage = selectBalancedRoadCandidates(
    roadsByDistance,
    roadCoverageTarget,
    minimumSeparationMeters,
    reserved,
  );
  const coverageIds = new Set(roadCoverage.map((point) => coinId(point)));
  const closestRemaining = roadsByDistance
    .flatMap(([, candidates]) => candidates)
    .filter((point) => !coverageIds.has(coinId(point)))
    .sort(
      (first, second) =>
        distanceSquared(first) - distanceSquared(second) ||
        coinId(first).localeCompare(coinId(second)),
    );
  const nearbyFill = selectBalancedRoadCandidates(
    [["nearby-fill", closestRemaining]],
    Math.max(0, target - roadCoverage.length),
    minimumSeparationMeters,
    [...reserved, ...roadCoverage],
  );
  return [...roadCoverage, ...nearbyFill];
}

/**
 * Creates a deterministic shared field from OpenStreetMap road centerlines.
 * The same road data always produces coins at the same coordinates for every player.
 */
export function createWorldStreetCoins(
  center: GeoCoordinate,
  segments: RoadSegment[],
): WorldCoin[] {
  const distanceSquared = localDistanceSquaredFrom(center);
  const roads = prioritizeRoadCandidatesNear(
    sampledRoadCandidatesByRoad(
      segments,
      (point) =>
        distanceSquared(point) <=
        WORLD_COIN_RADIUS_METERS * WORLD_COIN_RADIUS_METERS,
    ),
    center,
  );
  return selectNearbyRoadCandidates(
    roads,
    center,
    WORLD_COIN_MAXIMUM,
    WORLD_COIN_MINIMUM_SEPARATION_METERS,
  )
    .sort(
      (first, second) =>
        distanceInMeters(first, center) - distanceInMeters(second, center) ||
        coinId(first).localeCompare(coinId(second)),
    )
    .slice(0, WORLD_COIN_MAXIMUM)
    .map((point) => worldCoin(point));
}

/**
 * Generates only the deterministic positions for road segments that do not yet
 * have a persisted coin. Existing positions are treated as occupied space.
 */
export function createCoinsForMissingRoadSegments(
  center: GeoCoordinate,
  segments: RoadSegment[],
  existingCoins: WorldCoin[],
): WorldCoin[] {
  const distanceSquared = localDistanceSquaredFrom(center);
  const coveredRoads = new Set(
    existingCoins
      .filter((coin) => coin.densityVersion === WORLD_COIN_DENSITY_VERSION)
      .map((coin) => coin.roadSegmentId),
  );
  const missingSegments = segments.filter((segment) => !coveredRoads.has(segment.id));
  const roads = prioritizeRoadCandidatesNear(
    sampledRoadCandidatesByRoad(
      missingSegments,
      (point) =>
        distanceSquared(point) <=
        WORLD_COIN_RADIUS_METERS * WORLD_COIN_RADIUS_METERS,
    ),
    center,
  );
  const existingIds = new Set(existingCoins.map((coin) => coin.id));
  return selectNearbyRoadCandidates(
    roads,
    center,
    WORLD_COIN_MAXIMUM,
    WORLD_COIN_MINIMUM_SEPARATION_METERS,
    existingCoins,
  )
    .map((point) => worldCoin(point))
    .filter((coin) => !existingIds.has(coin.id));
}

/** City-wide variant used after loading the complete cached/online road region. */
export function createCoinsForMissingRoadSegmentsInBounds(
  bounds: GeoBounds,
  segments: RoadSegment[],
  existingCoins: WorldCoin[],
  target = WORLD_COIN_MAXIMUM,
  densityVersion = WORLD_COIN_DENSITY_VERSION,
): WorldCoin[] {
  const coveredRoads = new Set(
    existingCoins
      .filter((coin) => coin.densityVersion === densityVersion)
      .map((coin) => coin.roadSegmentId),
  );
  const roads = sampledRoadCandidatesByRoad(
    segments.filter((segment) => !coveredRoads.has(segment.id)),
    (point) => pointInsideBounds(point, bounds),
  );
  const existingIds = new Set(existingCoins.map((coin) => coin.id));
  return selectBalancedRoadCandidates(
    roads,
    Math.max(0, Math.floor(target)),
    WORLD_COIN_MINIMUM_SEPARATION_METERS,
    existingCoins,
  )
    .map((point) => worldCoin(point, densityVersion))
    .filter((coin) => !existingIds.has(coin.id));
}

/** Keeps visual/storage limits fair: one coin per road before taking extras. */
export function balanceCoinCatalogByRoad(
  coins: WorldCoin[],
  target = WORLD_COIN_TARGET,
): WorldCoin[] {
  const unique = new Map(coins.map((coin) => [coin.id, coin]));
  const byRoad = new Map<string, WorldCoin[]>();
  for (const coin of unique.values()) {
    const roadCoins = byRoad.get(coin.roadSegmentId) ?? [];
    roadCoins.push(coin);
    byRoad.set(coin.roadSegmentId, roadCoins);
  }
  const roads = [...byRoad.entries()]
    .sort(([first], [second]) =>
      stableHash(first) - stableHash(second) || first.localeCompare(second),
    )
    .map(([, roadCoins]) => roadCoins.sort((first, second) => first.id.localeCompare(second.id)));
  const cursors = roads.map(() => 0);
  const selected: WorldCoin[] = [];
  // El límite solicitado es estricto; el reparto circular conserva variedad vial.
  const safeTarget = Math.min(unique.size, Math.max(0, Math.floor(target)));
  while (selected.length < safeTarget) {
    let added = false;
    for (let index = 0; index < roads.length && selected.length < safeTarget; index += 1) {
      const coin = roads[index][cursors[index]];
      if (!coin) continue;
      cursors[index] += 1;
      selected.push(coin);
      added = true;
    }
    if (!added) break;
  }
  return selected;
}

/**
 * Last-resort visible seed used when the map reports too few markers. It is still
 * deterministic and derived exclusively from real cached OSM road geometry.
 */
export function createVisibleRoadCoinSeed(
  center: GeoCoordinate,
  segments: RoadSegment[],
  limit = 120,
): WorldCoin[] {
  return createWorldStreetCoins(center, segments)
    .slice(0, Math.max(0, Math.min(250, Math.floor(limit))))
    .map((coin) => {
      const id = `world-coin:debug:${coin.latitude.toFixed(6)}:${coin.longitude.toFixed(6)}`;
      return {
        ...coin,
        id,
        source: "debug_visible_seed" as const,
        hash: stableHash(`${coin.regionId}:${coin.roadSegmentId}:${coin.segmentIndex}:${id}`)
          .toString(16)
          .padStart(8, "0"),
      };
    });
}

/** Creates one stable city-wide catalog, spread across every road grid cell. */
export function createCityStreetCoinCatalog(
  bounds: GeoBounds,
  segments: RoadSegment[],
  target = WORLD_COIN_TARGET,
): WorldCoin[] {
  const roads = sampledRoadCandidatesByRoad(
    segments,
    (point) => pointInsideBounds(point, bounds),
    WORLD_COIN_SPACING_METERS,
  );
  const selected = selectBalancedRoadCandidates(
    roads,
    Math.max(0, Math.floor(target)),
    WORLD_COIN_MINIMUM_SEPARATION_METERS,
  );

  return selected.map((point) => worldCoin(point));
}
