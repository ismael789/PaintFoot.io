import { TERRITORY_RULES } from "../config/territory";
import type { GeoJsonPolygon, RawTrackPoint } from "../types/game";
import {
  closeRing,
  closestPointOnSegment,
  isSimplePolygon,
  polygonAreaM2,
  routeDistanceInMeters,
  toGeoJsonPolygon,
} from "../utils/geo";

export interface ProvisionalTerritoryCandidate {
  polygon: GeoJsonPolygon;
  areaM2: number;
  perimeterM: number;
}

// Esto solo crea evidencia pendiente. Nunca confirma ni renderiza un territorio.
export function detectProvisionalOfflineCandidate(
  rawTrack: RawTrackPoint[],
): ProvisionalTerritoryCandidate | null {
  if (rawTrack.length < TERRITORY_RULES.minimumDistinctPoints + 1) return null;
  const current = rawTrack[rawTrack.length - 1];
  let nearest:
    | { segmentIndex: number; distanceMeters: number; coordinate: RawTrackPoint }
    | null = null;

  for (let index = 0; index < rawTrack.length - 2; index += 1) {
    const projected = closestPointOnSegment(
      current,
      rawTrack[index],
      rawTrack[index + 1],
    );
    if (projected.distanceMeters > TERRITORY_RULES.closureToleranceMeters) {
      continue;
    }
    if (!nearest || projected.distanceMeters < nearest.distanceMeters) {
      nearest = {
        segmentIndex: index,
        distanceMeters: projected.distanceMeters,
        coordinate: {
          ...projected.coordinate,
          accuracy: current.accuracy,
          timestamp: current.timestamp,
        },
      };
    }
  }
  if (!nearest) return null;

  const ring = closeRing([
    nearest.coordinate,
    ...rawTrack.slice(nearest.segmentIndex + 1),
    nearest.coordinate,
  ]);
  if (!isSimplePolygon(ring)) return null;
  const perimeterM = routeDistanceInMeters(ring);
  const areaM2 = polygonAreaM2(ring);
  if (
    perimeterM < TERRITORY_RULES.minimumRouteDistanceMeters ||
    areaM2 < TERRITORY_RULES.minimumAreaM2
  ) {
    return null;
  }
  return { polygon: toGeoJsonPolygon(ring), areaM2, perimeterM };
}

export function hasSuspiciousClockChange(
  previousWallClock: number,
  currentWallClock: number,
  previousMonotonic: number,
  currentMonotonic: number,
  toleranceMs = 5_000,
) {
  const wallDelta = currentWallClock - previousWallClock;
  const monotonicDelta = currentMonotonic - previousMonotonic;
  if (monotonicDelta < 0) return true;
  return Math.abs(wallDelta - monotonicDelta) > toleranceMs;
}
