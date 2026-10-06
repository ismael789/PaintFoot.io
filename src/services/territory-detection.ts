import { TERRITORY_RULES } from "../config/territory";
import type {
  GeoCoordinate,
  PlayerProfile,
  RawTrackPoint,
  RoadSegment,
  Territory,
} from "../types/game";
import {
  closeRing,
  closestPointOnSegment,
  distanceInMeters,
  isSimplePolygon,
  polygonAreaM2,
  ringSignature,
  routeDistanceInMeters,
  segmentIntersection,
  toGeoJsonPolygon,
} from "../utils/geo";

export interface TerritoryDetectionRules {
  closureToleranceMeters: number;
  minimumAreaM2: number;
  minimumRouteDistanceMeters: number;
  minimumDistinctPoints: number;
}

export interface ClosedLoop {
  coordinates: GeoCoordinate[];
  areaM2: number;
  perimeterM: number;
  signature: string;
}

export interface TerritoryDetectionContext {
  currentSessionSegments?: RoadSegment[];
  rawTrack?: RawTrackPoint[];
}

const SESSION_GEOMETRY_TOLERANCE_METERS = 2;

function sharesRoadIdentity(
  firstStart: GeoCoordinate,
  firstEnd: GeoCoordinate,
  secondStart: GeoCoordinate,
  secondEnd: GeoCoordinate,
) {
  const firstSegmentIds = new Set(
    [firstStart.roadSegmentId, firstEnd.roadSegmentId].filter(Boolean),
  );
  const firstWayIds = new Set(
    [firstStart.roadWayId, firstEnd.roadWayId].filter(Boolean),
  );
  return (
    [secondStart.roadSegmentId, secondEnd.roadSegmentId].some(
      (id) => id !== undefined && firstSegmentIds.has(id),
    ) ||
    [secondStart.roadWayId, secondEnd.roadWayId].some(
      (id) => id !== undefined && id !== null && firstWayIds.has(id),
    )
  );
}

function isAtSegmentEndpoint(factor: number) {
  return factor <= 1e-5 || factor >= 1 - 1e-5;
}

function distanceToTrack(
  coordinate: GeoCoordinate,
  track: GeoCoordinate[],
) {
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < track.length - 1; index += 1) {
    minimumDistance = Math.min(
      minimumDistance,
      closestPointOnSegment(coordinate, track[index], track[index + 1])
        .distanceMeters,
    );
  }
  return minimumDistance;
}

function getCandidateSessionSegments(
  candidateTrack: GeoCoordinate[],
  currentSessionSegments: RoadSegment[],
) {
  return currentSessionSegments.filter((segment) => {
    const start = segment.coordinates[0];
    const end = segment.coordinates[segment.coordinates.length - 1];
    return (
      start !== undefined &&
      end !== undefined &&
      distanceToTrack(start, candidateTrack) <=
        SESSION_GEOMETRY_TOLERANCE_METERS &&
      distanceToTrack(end, candidateTrack) <= SESSION_GEOMETRY_TOLERANCE_METERS
    );
  });
}

function hasRoadGraphCycle(segments: RoadSegment[]) {
  const adjacency = new Map<
    string,
    Array<{ nodeId: string; segmentId: string }>
  >();

  for (const segment of segments) {
    const addEdge = (from: string, to: string) => {
      const connections = adjacency.get(from) ?? [];
      connections.push({ nodeId: to, segmentId: segment.id });
      adjacency.set(from, connections);
    };
    addEdge(segment.startNodeId, segment.endNodeId);
    addEdge(segment.endNodeId, segment.startNodeId);
  }

  const visitedNodes = new Set<string>();
  const visit = (nodeId: string, incomingSegmentId?: string): boolean => {
    visitedNodes.add(nodeId);
    for (const connection of adjacency.get(nodeId) ?? []) {
      if (connection.segmentId === incomingSegmentId) continue;
      if (visitedNodes.has(connection.nodeId)) return true;
      if (visit(connection.nodeId, connection.segmentId)) return true;
    }
    return false;
  };

  for (const nodeId of adjacency.keys()) {
    if (!visitedNodes.has(nodeId) && visit(nodeId)) return true;
  }
  return false;
}

function findNearestSegmentNode(
  coordinate: GeoCoordinate,
  segments: RoadSegment[],
) {
  let nearest:
    | { nodeId: string; coordinate: GeoCoordinate; distanceMeters: number }
    | undefined;

  for (const segment of segments) {
    const nodes = [
      { nodeId: segment.startNodeId, coordinate: segment.coordinates[0] },
      {
        nodeId: segment.endNodeId,
        coordinate: segment.coordinates[segment.coordinates.length - 1],
      },
    ];
    for (const node of nodes) {
      if (!node.coordinate) continue;
      const distanceMeters = distanceInMeters(coordinate, node.coordinate);
      if (!nearest || distanceMeters < nearest.distanceMeters) {
        nearest = { ...node, distanceMeters };
      }
    }
  }
  return nearest;
}

function hasRoadPath(
  segments: RoadSegment[],
  startNodeId: string,
  endNodeId: string,
  minimumSegmentCount: number,
) {
  const adjacency = new Map<string, Array<{ nodeId: string; segmentId: string }>>();
  for (const segment of segments) {
    const startConnections = adjacency.get(segment.startNodeId) ?? [];
    startConnections.push({ nodeId: segment.endNodeId, segmentId: segment.id });
    adjacency.set(segment.startNodeId, startConnections);
    const endConnections = adjacency.get(segment.endNodeId) ?? [];
    endConnections.push({ nodeId: segment.startNodeId, segmentId: segment.id });
    adjacency.set(segment.endNodeId, endConnections);
  }

  const pending = [{ nodeId: startNodeId, usedSegments: new Set<string>() }];
  const bestDepth = new Map<string, number>([[startNodeId, 0]]);
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    if (
      current.nodeId === endNodeId &&
      current.usedSegments.size >= minimumSegmentCount
    ) {
      return true;
    }

    for (const connection of adjacency.get(current.nodeId) ?? []) {
      if (current.usedSegments.has(connection.segmentId)) continue;
      const nextSegments = new Set(current.usedSegments);
      nextSegments.add(connection.segmentId);
      const previousDepth = bestDepth.get(connection.nodeId) ?? -1;
      if (previousDepth >= nextSegments.size) continue;
      bestDepth.set(connection.nodeId, nextSegments.size);
      pending.push({ nodeId: connection.nodeId, usedSegments: nextSegments });
    }
  }
  return false;
}

function gpsUncertaintySupportsClosure(
  projection: GeoCoordinate,
  currentEnd: GeoCoordinate,
  rawTrack: RawTrackPoint[],
  closureToleranceMeters: number,
) {
  if (rawTrack.length < 3) return false;
  const currentRaw = rawTrack[rawTrack.length - 1];
  if (
    currentRaw.accuracy === null ||
    currentRaw.accuracy <= 0 ||
    distanceInMeters(currentRaw, currentEnd) >
      currentRaw.accuracy + SESSION_GEOMETRY_TOLERANCE_METERS
  ) {
    return false;
  }

  let previousRaw: RawTrackPoint | undefined;
  let previousDistance = Number.POSITIVE_INFINITY;
  for (const point of rawTrack.slice(0, -2)) {
    const distance = distanceInMeters(point, projection);
    if (distance < previousDistance) {
      previousRaw = point;
      previousDistance = distance;
    }
  }
  if (!previousRaw || previousRaw.accuracy === null || previousRaw.accuracy <= 0) {
    return false;
  }
  if (
    previousDistance >
    previousRaw.accuracy + SESSION_GEOMETRY_TOLERANCE_METERS
  ) {
    return false;
  }

  const reportedClosureDistance = distanceInMeters(previousRaw, currentRaw);
  const combinedAccuracy = previousRaw.accuracy + currentRaw.accuracy;
  return (
    reportedClosureDistance <= closureToleranceMeters &&
    reportedClosureDistance <= combinedAccuracy
  );
}

function hasCompleteCurrentSessionCircuit(
  candidateTrack: GeoCoordinate[],
  projection: GeoCoordinate,
  currentEnd: GeoCoordinate,
  rules: TerritoryDetectionRules,
  context: TerritoryDetectionContext,
) {
  const sessionSegments = getCandidateSessionSegments(
    candidateTrack,
    context.currentSessionSegments ?? [],
  );
  if (sessionSegments.length < rules.minimumDistinctPoints) return false;
  if (hasRoadGraphCycle(sessionSegments)) return true;

  if (
    !gpsUncertaintySupportsClosure(
      projection,
      currentEnd,
      context.rawTrack ?? [],
      rules.closureToleranceMeters,
    )
  ) {
    return false;
  }

  const closureNode = findNearestSegmentNode(projection, sessionSegments);
  const currentNode = findNearestSegmentNode(currentEnd, sessionSegments);
  if (
    !closureNode ||
    !currentNode ||
    closureNode.distanceMeters > SESSION_GEOMETRY_TOLERANCE_METERS ||
    currentNode.distanceMeters > SESSION_GEOMETRY_TOLERANCE_METERS
  ) {
    return false;
  }

  return hasRoadPath(
    sessionSegments,
    closureNode.nodeId,
    currentNode.nodeId,
    rules.minimumDistinctPoints,
  );
}

function validateLoop(
  candidate: GeoCoordinate[],
  rules: TerritoryDetectionRules,
): ClosedLoop | null {
  const coordinates = closeRing(candidate);
  const distinctPoints = new Set(
    coordinates
      .slice(0, -1)
      .map(
        (coordinate) =>
          `${coordinate.latitude.toFixed(6)}:${coordinate.longitude.toFixed(6)}`,
      ),
  ).size;

  if (distinctPoints < rules.minimumDistinctPoints) return null;
  if (!isSimplePolygon(coordinates)) return null;

  const perimeterM = routeDistanceInMeters(coordinates);
  if (perimeterM < rules.minimumRouteDistanceMeters) return null;

  const areaM2 = polygonAreaM2(coordinates);
  if (areaM2 < rules.minimumAreaM2) return null;

  const signature = ringSignature(coordinates);
  if (!signature) return null;

  return { coordinates, areaM2, perimeterM, signature };
}

export function detectClosedLoops(
  snappedTrack: GeoCoordinate[],
  startSegmentIndex = 1,
  rules: TerritoryDetectionRules = TERRITORY_RULES,
  context: TerritoryDetectionContext = {},
) {
  const loops = new Map<string, ClosedLoop>();
  if (snappedTrack.length < rules.minimumDistinctPoints + 1) return [];

  const firstSegmentToCheck = Math.max(2, startSegmentIndex);
  for (
    let currentSegmentIndex = firstSegmentToCheck;
    currentSegmentIndex < snappedTrack.length - 1;
    currentSegmentIndex += 1
  ) {
    const currentStart = snappedTrack[currentSegmentIndex];
    const currentEnd = snappedTrack[currentSegmentIndex + 1];

    for (
      let previousSegmentIndex = 0;
      previousSegmentIndex < currentSegmentIndex - 1;
      previousSegmentIndex += 1
    ) {
      const intersection = segmentIntersection(
        currentStart,
        currentEnd,
        snappedTrack[previousSegmentIndex],
        snappedTrack[previousSegmentIndex + 1],
      );
      if (!intersection) continue;

      const previousStart = snappedTrack[previousSegmentIndex];
      const previousEnd = snappedTrack[previousSegmentIndex + 1];
      const connectedAtRoadNode =
        isAtSegmentEndpoint(intersection.firstFactor) &&
        isAtSegmentEndpoint(intersection.secondFactor);
      if (
        !connectedAtRoadNode &&
        !sharesRoadIdentity(
          currentStart,
          currentEnd,
          previousStart,
          previousEnd,
        )
      ) {
        continue;
      }

      const loop = validateLoop(
        [
          intersection.coordinate,
          ...snappedTrack.slice(
            previousSegmentIndex + 1,
            currentSegmentIndex + 1,
          ),
          intersection.coordinate,
        ],
        rules,
      );
      if (loop) loops.set(loop.signature, loop);
    }

    // La tolerancia solo propone un cierre para el punto mas reciente. Nunca
    // debe convertir por si sola un tramo historico cercano en territorio.
    if (currentSegmentIndex !== snappedTrack.length - 2) continue;

    let nearestClosure:
      | {
          previousSegmentIndex: number;
          coordinate: GeoCoordinate;
          distanceMeters: number;
        }
      | undefined;

    for (
      let previousSegmentIndex = 0;
      previousSegmentIndex < currentSegmentIndex - 1;
      previousSegmentIndex += 1
    ) {
      const projected = closestPointOnSegment(
        currentEnd,
        snappedTrack[previousSegmentIndex],
        snappedTrack[previousSegmentIndex + 1],
      );
      if (projected.distanceMeters > rules.closureToleranceMeters) continue;
      const previousStart = snappedTrack[previousSegmentIndex];
      const previousEnd = snappedTrack[previousSegmentIndex + 1];
      const nearPreviousRoadNode =
        projected.factor <= 0.05 || projected.factor >= 0.95;
      if (
        !nearPreviousRoadNode &&
        !sharesRoadIdentity(
          currentStart,
          currentEnd,
          previousStart,
          previousEnd,
        )
      ) {
        continue;
      }
      if (
        !nearestClosure ||
        projected.distanceMeters < nearestClosure.distanceMeters
      ) {
        nearestClosure = {
          previousSegmentIndex,
          coordinate: projected.coordinate,
          distanceMeters: projected.distanceMeters,
        };
      }
    }

    if (nearestClosure) {
      const candidateTrack = [
        nearestClosure.coordinate,
        ...snappedTrack.slice(
          nearestClosure.previousSegmentIndex + 1,
          currentSegmentIndex + 2,
        ),
      ];
      if (
        !hasCompleteCurrentSessionCircuit(
          candidateTrack,
          nearestClosure.coordinate,
          currentEnd,
          rules,
          context,
        )
      ) {
        continue;
      }

      const loop = validateLoop(
        [...candidateTrack, nearestClosure.coordinate],
        rules,
      );
      if (loop) loops.set(loop.signature, loop);
    }
  }

  return [...loops.values()];
}

export function createTerritoryFromLoop(
  loop: ClosedLoop,
  player: PlayerProfile,
  createdAt = Date.now(),
  suffix = 0,
): Territory {
  return {
    id: `territory-${player.id}-${createdAt}-${suffix}`,
    playerId: player.id,
    playerColor: player.color,
    polygon: toGeoJsonPolygon(loop.coordinates),
    areaM2: loop.areaM2,
    createdAt,
    signature: loop.signature,
    coordinates: loop.coordinates,
    color: player.color,
    owner: player.name,
  };
}

export function isNearExistingTrack(
  coordinate: GeoCoordinate,
  track: GeoCoordinate[],
  toleranceMeters = TERRITORY_RULES.closureToleranceMeters,
) {
  for (let index = 0; index < track.length - 1; index += 1) {
    const projected = closestPointOnSegment(
      coordinate,
      track[index],
      track[index + 1],
    );
    if (projected.distanceMeters <= toleranceMeters) return true;
  }
  return false;
}

export function countDistinctCoordinates(coordinates: GeoCoordinate[]) {
  const distinct: GeoCoordinate[] = [];
  for (const coordinate of coordinates) {
    if (
      distinct.every(
        (knownCoordinate) =>
          distanceInMeters(knownCoordinate, coordinate) > 0.5,
      )
    ) {
      distinct.push(coordinate);
    }
  }
  return distinct.length;
}
