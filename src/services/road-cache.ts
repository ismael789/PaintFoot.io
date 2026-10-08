import { ROAD_MATCHING_RULES } from "@/config/territory";
import {
  getRoadCacheCoverage,
  getRoadSegmentsNearTrack,
  saveRoadSegmentsToCache,
} from "@/services/offline-storage";
import type { RoadMatchResult } from "@/services/road-matching";
import type { GeoCoordinate, RawTrackPoint, RoadSegment } from "@/types/game";
import { closestPointOnSegment } from "@/utils/geo";

export async function cacheRoadMatchResult(result: RoadMatchResult) {
  await saveRoadSegmentsToCache(result.segments);
}

interface CachedProjection {
  coordinate: GeoCoordinate;
  segment: RoadSegment;
  distanceMeters: number;
}

function nearestCachedProjection(
  point: RawTrackPoint,
  segments: RoadSegment[],
): CachedProjection | null {
  let nearest: CachedProjection | null = null;
  for (const segment of segments) {
    for (let index = 0; index < segment.coordinates.length - 1; index += 1) {
      const projected = closestPointOnSegment(
        point,
        segment.coordinates[index],
        segment.coordinates[index + 1],
      );
      if (!nearest || projected.distanceMeters < nearest.distanceMeters) {
        nearest = {
          coordinate: projected.coordinate,
          segment,
          distanceMeters: projected.distanceMeters,
        };
      }
    }
  }
  return nearest;
}

export async function matchTraceFromRoadCache(
  rawTrack: RawTrackPoint[],
): Promise<RoadMatchResult | null> {
  if (rawTrack.length < 2) return null;
  const cachedSegments = await getRoadSegmentsNearTrack(rawTrack);
  if (cachedSegments.length === 0) return null;

  const projections = rawTrack.map((point) =>
    nearestCachedProjection(point, cachedSegments),
  );
  const cacheIsSufficient = projections.every((projection, index) => {
    if (!projection) return false;
    const accuracy = rawTrack[index].accuracy;
    const allowedDistance = Math.min(
      ROAD_MATCHING_RULES.searchRadiusMeters,
      Math.max(15, (accuracy ?? 10) + 8),
    );
    return projection.distanceMeters <= allowedDistance;
  });
  if (!cacheIsSufficient) return null;

  const snappedTrack = projections.map((projection, index) => ({
    ...projection!.coordinate,
    timestamp: rawTrack[index].timestamp,
    roadSegmentId: projection!.segment.id,
    roadWayId: projection!.segment.wayId,
  }));
  const traversedSegments = new Map<string, RoadSegment>();
  for (const projection of projections) {
    if (projection) traversedSegments.set(projection.segment.id, projection.segment);
  }

  return {
    snappedTrack,
    segments: [...traversedSegments.values()],
    matchedPointCount: snappedTrack.length,
    unmatchedPointCount: 0,
    source: "cache",
    cacheCoverageComplete: (await getRoadCacheCoverage(rawTrack)).sufficient,
  };
}
