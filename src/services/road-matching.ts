import { ROAD_MATCHING_RULES } from "../config/territory";
import type {
  GeoCoordinate,
  RawTrackPoint,
  RoadGraph,
  RoadNode,
  RoadSegment,
} from "../types/game";
import { debugLog } from "../utils/debug-log";
import { coordinateNodeId, distanceInMeters } from "../utils/geo";
import { getMapMatchingTurnPenalty } from "./sensor-fusion";

interface ValhallaMatchedPoint {
  lat?: number;
  lon?: number;
  type?: "matched" | "interpolated" | "unmatched";
  edge_index?: number;
  distance_from_trace_point?: number;
}

interface ValhallaEdge {
  id?: string | number;
  way_id?: string | number;
  names?: string[];
  begin_shape_index?: number;
  end_shape_index?: number;
  begin_heading?: number;
  end_heading?: number;
  end_node?: {
    type?: string;
    intersecting_edges?: Array<{ walkability?: string }>;
  };
}

interface ValhallaResponse {
  shape?: string;
  edges?: ValhallaEdge[];
  matched_points?: ValhallaMatchedPoint[];
  error?: string;
  error_code?: number;
}

export interface RoadMatchResult {
  snappedTrack: GeoCoordinate[];
  segments: RoadSegment[];
  matchedPointCount: number;
  unmatchedPointCount: number;
  source?: "network" | "cache";
  serverTimeMs?: number | null;
  cacheCoverageComplete?: boolean;
}

interface MatchTraceOptions {
  endpoint?: string;
  signal?: AbortSignal;
  fetchImplementation?: typeof fetch;
}

export function getRoadMatchingWindow(
  rawPointCount: number,
  matchedPointCount: number,
) {
  const start = Math.max(
    0,
    matchedPointCount - ROAD_MATCHING_RULES.overlapRawPoints,
  );
  return {
    start,
    end: Math.min(
      rawPointCount,
      start + ROAD_MATCHING_RULES.maxRawPointsPerRequest,
    ),
  };
}

export class RoadMatchingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoadMatchingError";
  }
}

export function decodeValhallaPolyline(
  encoded: string,
  precision = 6,
): GeoCoordinate[] {
  const coordinates: GeoCoordinate[] = [];
  const factor = 10 ** precision;
  let latitude = 0;
  let longitude = 0;
  let index = 0;

  const decodeValue = () => {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      if (index >= encoded.length) {
        throw new RoadMatchingError("La geometria vial recibida esta incompleta.");
      }
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    latitude += decodeValue();
    longitude += decodeValue();
    coordinates.push({
      latitude: latitude / factor,
      longitude: longitude / factor,
    });
  }

  return coordinates;
}

function createRoadSegments(
  edges: ValhallaEdge[],
  snappedTrack: GeoCoordinate[],
) {
  return edges.flatMap<RoadSegment>((edge, index) => {
    const begin = edge.begin_shape_index;
    const end = edge.end_shape_index;
    if (
      begin === undefined ||
      end === undefined ||
      begin < 0 ||
      end < begin ||
      end >= snappedTrack.length
    ) {
      return [];
    }

    const edgeId = String(edge.id ?? `edge-${index}`);
    const wayId = edge.way_id === undefined ? null : String(edge.way_id);
    const unannotatedCoordinates = snappedTrack.slice(begin, end + 1);
    if (unannotatedCoordinates.length < 2) return [];
    const startNodeId = coordinateNodeId(unannotatedCoordinates[0]);
    const endNodeId = coordinateNodeId(
      unannotatedCoordinates[unannotatedCoordinates.length - 1],
    );
    const segmentId = `${edgeId}:${startNodeId}:${endNodeId}`;
    for (let shapeIndex = begin; shapeIndex <= end; shapeIndex += 1) {
      snappedTrack[shapeIndex] = {
        ...snappedTrack[shapeIndex],
        roadSegmentId: segmentId,
        roadWayId: wayId,
      };
    }
    const coordinates = snappedTrack.slice(begin, end + 1);

    return [
      {
        id: segmentId,
        wayId,
        name: edge.names?.[0] ?? null,
        coordinates,
        startNodeId,
        endNodeId,
        intersectingEdgeCount: edge.end_node?.intersecting_edges?.length ?? 0,
        endNodeType: edge.end_node?.type ?? null,
        beginHeading: edge.begin_heading,
        endHeading: edge.end_heading,
      },
    ];
  });
}

export async function matchTraceToRoads(
  rawTrack: RawTrackPoint[],
  options: MatchTraceOptions = {},
): Promise<RoadMatchResult> {
  if (rawTrack.length < 2) {
    throw new RoadMatchingError(
      "Se necesitan al menos dos puntos GPS para ajustar el recorrido.",
    );
  }

  const endpoint = options.endpoint ?? ROAD_MATCHING_RULES.endpoint;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const reportedAccuracies = rawTrack
    .map((point) => point.accuracy)
    .filter((accuracy): accuracy is number => accuracy !== null);
  const gpsAccuracy = Math.max(
    5,
    Math.min(
      ROAD_MATCHING_RULES.searchRadiusMeters,
      reportedAccuracies.length > 0
        ? Math.max(...reportedAccuracies)
        : ROAD_MATCHING_RULES.searchRadiusMeters,
    ),
  );

  const timeoutController = options.signal ? null : new AbortController();
  const turnPenaltyFactor = getMapMatchingTurnPenalty(rawTrack);
  const timeout = timeoutController
    ? setTimeout(
        () => timeoutController.abort(),
        ROAD_MATCHING_RULES.requestTimeoutMs,
      )
    : null;
  let response: Response;

  try {
    response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Client-Id": "paintfoot.io",
      },
      body: JSON.stringify({
      shape: rawTrack.map((point) => ({
        lat: point.latitude,
        lon: point.longitude,
      })),
      costing: "pedestrian",
      shape_match: "map_snap",
      trace_options: {
        gps_accuracy: gpsAccuracy,
        search_radius: ROAD_MATCHING_RULES.searchRadiusMeters,
        turn_penalty_factor: turnPenaltyFactor,
      },
      filters: {
        action: "include",
        attributes: [
          "shape",
          "edge.id",
          "edge.way_id",
          "edge.names",
          "edge.begin_shape_index",
          "edge.end_shape_index",
          "edge.begin_heading",
          "edge.end_heading",
          "node.type",
          "node.intersecting_edge.walkability",
          "matched.point",
          "matched.type",
          "matched.edge_index",
          "matched.distance_from_trace_point",
        ],
      },
      }),
      signal: options.signal ?? timeoutController?.signal,
    });
  } catch (error) {
    if (timeoutController?.signal.aborted) {
      throw new RoadMatchingError(
        "El servicio vial tardo demasiado en responder.",
      );
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  const responseText = await response.text();
  let payload: ValhallaResponse;
  try {
    payload = JSON.parse(responseText) as ValhallaResponse;
  } catch {
    throw new RoadMatchingError(
      `El servicio vial devolvio una respuesta invalida (${response.status}).`,
    );
  }

  if (!response.ok || payload.error) {
    throw new RoadMatchingError(
      payload.error || `El servicio vial respondio ${response.status}.`,
    );
  }
  if (!payload.shape) {
    throw new RoadMatchingError("El servicio vial no devolvio una ruta ajustada.");
  }

  const snappedTrack = decodeValhallaPolyline(payload.shape);
  if (snappedTrack.length < 2) {
    throw new RoadMatchingError("La ruta vial ajustada no contiene suficientes puntos.");
  }

  const matchedPoints = payload.matched_points ?? [];
  const unmatchedPointCount = matchedPoints.filter(
    (point) => point.type === "unmatched",
  ).length;
  if (
    matchedPoints.length > 0 &&
    unmatchedPointCount / matchedPoints.length >
      ROAD_MATCHING_RULES.maximumUnmatchedRatio
  ) {
    throw new RoadMatchingError(
      "Demasiados puntos GPS quedaron fuera de la red de calles.",
    );
  }

  const segments = createRoadSegments(payload.edges ?? [], snappedTrack);
  debugLog(
    "ROAD",
    `Ruta ajustada: ${snappedTrack.length} puntos y ${segments.length} segmentos.`,
  );

  return {
    snappedTrack,
    segments,
    matchedPointCount: matchedPoints.length - unmatchedPointCount,
    unmatchedPointCount,
    source: "network",
    serverTimeMs: (() => {
      const serverDate = response.headers?.get?.("date");
      if (!serverDate) return null;
      const parsed = Date.parse(serverDate);
      return Number.isFinite(parsed) ? parsed : null;
    })(),
  };
}

export function mergeMatchedTrack(
  previousTrack: GeoCoordinate[],
  replacementTrack: GeoCoordinate[],
  toleranceMeters = ROAD_MATCHING_RULES.mergeToleranceMeters,
) {
  if (previousTrack.length === 0) return replacementTrack;
  if (replacementTrack.length === 0) return previousTrack;

  const replacementStart = replacementTrack[0];
  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const searchStart = Math.max(0, previousTrack.length - 1_000);

  for (let index = searchStart; index < previousTrack.length; index += 1) {
    const distance = distanceInMeters(previousTrack[index], replacementStart);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  if (nearestIndex < 0 || nearestDistance > toleranceMeters) {
    throw new RoadMatchingError(
      "No se pudo unir el nuevo tramo con la ruta vial anterior sin crear un atajo.",
    );
  }

  return [...previousTrack.slice(0, nearestIndex), ...replacementTrack];
}

export function mergeRoadSegments(
  previousSegments: RoadSegment[],
  replacementSegments: RoadSegment[],
) {
  const segments = new Map<string, RoadSegment>();
  for (const segment of [...previousSegments, ...replacementSegments]) {
    segments.set(segment.id, segment);
  }
  return [...segments.values()];
}

export function buildRoadGraph(segments: RoadSegment[]): RoadGraph {
  const nodes = new Map<string, RoadNode>();

  const addSegmentToNode = (
    nodeId: string,
    coordinate: GeoCoordinate,
    segmentId: string,
    externalConnectionCount = 0,
    type: string | null = null,
  ) => {
    const current = nodes.get(nodeId) ?? {
      id: nodeId,
      coordinate,
      segmentIds: [],
      externalConnectionCount,
      type,
    };
    if (!current.segmentIds.includes(segmentId)) {
      current.segmentIds.push(segmentId);
    }
    current.externalConnectionCount = Math.max(
      current.externalConnectionCount,
      externalConnectionCount,
    );
    current.type = current.type ?? type;
    nodes.set(nodeId, current);
  };

  for (const segment of segments) {
    addSegmentToNode(
      segment.startNodeId,
      segment.coordinates[0],
      segment.id,
    );
    addSegmentToNode(
      segment.endNodeId,
      segment.coordinates[segment.coordinates.length - 1],
      segment.id,
      segment.intersectingEdgeCount,
      segment.endNodeType,
    );
  }

  const roadNodes = [...nodes.values()];
  return {
    nodes: roadNodes,
    segments,
    intersectionCount: roadNodes.filter(
      (node) =>
        node.externalConnectionCount > 0 || node.segmentIds.length >= 3,
    ).length,
  };
}
