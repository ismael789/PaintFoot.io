import { REGIONAL_CACHE_CONFIG } from "@/config/offline";
import {
  coordinateRegionId,
  neighboringRoadRegionIds,
  roadRegionBoundsFromId,
  saveRoadSegmentsToCache,
} from "@/services/offline-storage";
import type { GeoCoordinate, RoadSegment } from "@/types/game";
import type { GeoBounds } from "@/services/world-coins";
import { coordinateNodeId } from "@/utils/geo";
import { debugLog } from "@/utils/debug-log";
import bundledSlrcRoadSegments from "../../assets/data/slrc-walkable-roads.json";

interface OverpassElement {
  type: "way" | string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

const refreshedAtByArea = new Map<string, number>();
const requestsInFlight = new Map<string, Promise<void>>();
const REFRESH_INTERVAL_MS = 15 * 60 * 1_000;

export const SAN_LUIS_RIO_COLORADO_URBAN_BOUNDS: GeoBounds = {
  south: 32.4,
  west: -114.8334,
  north: 32.5,
  east: -114.7,
};

export function isInsideSanLuisRioColoradoUrbanArea(coordinate: GeoCoordinate) {
  const bounds = SAN_LUIS_RIO_COLORADO_URBAN_BOUNDS;
  return (
    coordinate.latitude >= bounds.south &&
    coordinate.latitude <= bounds.north &&
    coordinate.longitude >= bounds.west &&
    coordinate.longitude <= bounds.east
  );
}

/** Real OSM streets bundled with the app so the city coin field works offline. */
export function getBundledSanLuisRioColoradoRoadSegments(): RoadSegment[] {
  return bundledSlrcRoadSegments as RoadSegment[];
}

/** Loads only bundled roads intersecting the requested local area. */
export function getBundledSanLuisRioColoradoRoadSegmentsNear(
  coordinate: GeoCoordinate,
  radiusMeters: number,
): RoadSegment[] {
  const latitudePadding = radiusMeters / 111_320;
  const longitudePadding = radiusMeters /
    (111_320 * Math.max(0.2, Math.cos((coordinate.latitude * Math.PI) / 180)));
  const south = coordinate.latitude - latitudePadding;
  const north = coordinate.latitude + latitudePadding;
  const west = coordinate.longitude - longitudePadding;
  const east = coordinate.longitude + longitudePadding;
  return getBundledSanLuisRioColoradoRoadSegments().filter((segment) => {
    if (segment.coordinates.length < 2) return false;
    const latitudes = segment.coordinates.map((point) => point.latitude);
    const longitudes = segment.coordinates.map((point) => point.longitude);
    return (
      Math.max(...latitudes) >= south &&
      Math.min(...latitudes) <= north &&
      Math.max(...longitudes) >= west &&
      Math.min(...longitudes) <= east
    );
  });
}

function overpassSegments(payload: OverpassResponse): RoadSegment[] {
  const excludedForWalking = new Set([
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "construction",
    "proposed",
    "raceway",
  ]);
  const ways = (payload.elements ?? []).filter(
    (element) =>
      element.type === "way" &&
      (element.geometry?.length ?? 0) >= 2 &&
      !excludedForWalking.has(element.tags?.highway ?? "") &&
      element.tags?.access !== "private" &&
      element.tags?.foot !== "no",
  );
  const nodeUseCount = new Map<string, number>();
  for (const way of ways) {
    for (const node of way.geometry ?? []) {
      const id = coordinateNodeId({ latitude: node.lat, longitude: node.lon });
      nodeUseCount.set(id, (nodeUseCount.get(id) ?? 0) + 1);
    }
  }
  return ways.map((way) => {
    const coordinates = (way.geometry ?? []).map<GeoCoordinate>((node) => ({
      latitude: node.lat,
      longitude: node.lon,
    }));
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    const startNodeId = coordinateNodeId(first);
    const endNodeId = coordinateNodeId(last);
    return {
      id: `osm-way-${way.id}`,
      wayId: String(way.id),
      name: way.tags?.name ?? null,
      coordinates,
      startNodeId,
      endNodeId,
      intersectingEdgeCount: Math.max(
        nodeUseCount.get(startNodeId) ?? 1,
        nodeUseCount.get(endNodeId) ?? 1,
      ),
      endNodeType: way.tags?.junction ?? null,
    };
  });
}

export async function fetchRoadNetworkForBounds(
  bounds: GeoBounds,
  fetchImplementation: typeof fetch = fetch,
) {
  const query = `[out:json][timeout:60];way["highway"](${bounds.south},${bounds.west},${bounds.north},${bounds.east});out tags geom;`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
  try {
    const response = await fetchImplementation(REGIONAL_CACHE_CONFIG.overpassEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return overpassSegments((await response.json()) as OverpassResponse);
  } finally {
    clearTimeout(timeout);
  }
}

function segmentTouchesRegion(segment: RoadSegment, regionId: string) {
  const bounds = roadRegionBoundsFromId(regionId);
  if (!bounds) return false;
  const latitudes = segment.coordinates.map((point) => point.latitude);
  const longitudes = segment.coordinates.map((point) => point.longitude);
  return (
    Math.max(...latitudes) >= bounds.minLat &&
    Math.min(...latitudes) <= bounds.maxLat &&
    Math.max(...longitudes) >= bounds.minLon &&
    Math.min(...longitudes) <= bounds.maxLon
  );
}

export async function prefetchRoadRegionsNear(
  coordinate: GeoCoordinate,
  fetchImplementation: typeof fetch = fetch,
) {
  const centerRegionId = coordinateRegionId(coordinate);
  const regionIds = neighboringRoadRegionIds(coordinate);
  const areaKey = regionIds.join("|");
  const lastRefresh = refreshedAtByArea.get(areaKey) ?? 0;
  if (Date.now() - lastRefresh < REFRESH_INTERVAL_MS) return;
  const inFlight = requestsInFlight.get(areaKey);
  if (inFlight) return inFlight;

  const request = (async () => {
    const bounds = regionIds
      .map(roadRegionBoundsFromId)
      .filter((value): value is NonNullable<typeof value> => value !== null);
    if (bounds.length === 0) return;
    const south = Math.min(...bounds.map((item) => item.minLat));
    const west = Math.min(...bounds.map((item) => item.minLon));
    const north = Math.max(...bounds.map((item) => item.maxLat));
    const east = Math.max(...bounds.map((item) => item.maxLon));
    const query = `[out:json][timeout:25];way["highway"](${south},${west},${north},${east});out tags geom;`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let segments: RoadSegment[];
    try {
      const response = await fetchImplementation(REGIONAL_CACHE_CONFIG.overpassEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      segments = overpassSegments((await response.json()) as OverpassResponse);
    } finally {
      clearTimeout(timeout);
    }
    for (const regionId of regionIds) {
      const regionalSegments = segments.filter((segment) =>
        segmentTouchesRegion(segment, regionId),
      );
      if (regionalSegments.length === 0) continue;
      await saveRoadSegmentsToCache(regionalSegments, {
        regionId,
        coverageStatus: "complete",
        priority: regionId === centerRegionId ? 80 : 60,
      });
    }
    refreshedAtByArea.set(areaKey, Date.now());
  })()
    .catch(() => {
      debugLog(
        "ROAD",
        "Los mapas guardados se actualizaran cuando la conexion sea estable.",
      );
    })
    .finally(() => requestsInFlight.delete(areaKey));
  requestsInFlight.set(areaKey, request);
  return request;
}

