import type { GeoCoordinate, GeoJsonPolygon } from "../types/game";

const EARTH_RADIUS_METERS = 6_371_000;

interface LocalPoint {
  x: number;
  y: number;
}

export interface SegmentIntersection {
  coordinate: GeoCoordinate;
  firstFactor: number;
  secondFactor: number;
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function toDegrees(value: number) {
  return (value * 180) / Math.PI;
}

function toLocalPoint(
  coordinate: GeoCoordinate,
  reference: GeoCoordinate,
): LocalPoint {
  const referenceLatitude = toRadians(reference.latitude);
  return {
    x:
      toRadians(coordinate.longitude - reference.longitude) *
      EARTH_RADIUS_METERS *
      Math.cos(referenceLatitude),
    y:
      toRadians(coordinate.latitude - reference.latitude) * EARTH_RADIUS_METERS,
  };
}

function fromLocalPoint(
  point: LocalPoint,
  reference: GeoCoordinate,
): GeoCoordinate {
  const referenceLatitude = toRadians(reference.latitude);
  return {
    latitude:
      reference.latitude + toDegrees(point.y / EARTH_RADIUS_METERS),
    longitude:
      reference.longitude +
      toDegrees(point.x / (EARTH_RADIUS_METERS * Math.cos(referenceLatitude))),
  };
}

export function distanceInMeters(
  first: GeoCoordinate,
  second: GeoCoordinate,
) {
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(first.latitude)) *
      Math.cos(toRadians(second.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  );
}

export function bearingDegrees(
  first: GeoCoordinate,
  second: GeoCoordinate,
) {
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const y = Math.sin(longitudeDelta) * Math.cos(secondLatitude);
  const x =
    Math.cos(firstLatitude) * Math.sin(secondLatitude) -
    Math.sin(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.cos(longitudeDelta);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

export function routeDistanceInMeters(coordinates: GeoCoordinate[]) {
  let distance = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    distance += distanceInMeters(coordinates[index - 1], coordinates[index]);
  }
  return distance;
}

export function closestPointOnSegment(
  point: GeoCoordinate,
  start: GeoCoordinate,
  end: GeoCoordinate,
) {
  const localPoint = toLocalPoint(point, start);
  const localEnd = toLocalPoint(end, start);
  const lengthSquared = localEnd.x ** 2 + localEnd.y ** 2;
  const factor =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            (localPoint.x * localEnd.x + localPoint.y * localEnd.y) /
              lengthSquared,
          ),
        );
  const projected = {
    x: localEnd.x * factor,
    y: localEnd.y * factor,
  };
  const deltaX = localPoint.x - projected.x;
  const deltaY = localPoint.y - projected.y;

  return {
    coordinate: fromLocalPoint(projected, start),
    distanceMeters: Math.hypot(deltaX, deltaY),
    factor,
  };
}

export function segmentIntersection(
  firstStart: GeoCoordinate,
  firstEnd: GeoCoordinate,
  secondStart: GeoCoordinate,
  secondEnd: GeoCoordinate,
): SegmentIntersection | null {
  const firstEndLocal = toLocalPoint(firstEnd, firstStart);
  const secondStartLocal = toLocalPoint(secondStart, firstStart);
  const secondEndLocal = toLocalPoint(secondEnd, firstStart);
  const firstDelta = firstEndLocal;
  const secondDelta = {
    x: secondEndLocal.x - secondStartLocal.x,
    y: secondEndLocal.y - secondStartLocal.y,
  };
  const denominator =
    firstDelta.x * secondDelta.y - firstDelta.y * secondDelta.x;

  if (Math.abs(denominator) < 1e-9) return null;

  const offset = secondStartLocal;
  const firstFactor =
    (offset.x * secondDelta.y - offset.y * secondDelta.x) / denominator;
  const secondFactor =
    (offset.x * firstDelta.y - offset.y * firstDelta.x) / denominator;
  const tolerance = 1e-7;

  if (
    firstFactor < -tolerance ||
    firstFactor > 1 + tolerance ||
    secondFactor < -tolerance ||
    secondFactor > 1 + tolerance
  ) {
    return null;
  }

  return {
    coordinate: fromLocalPoint(
      {
        x: firstDelta.x * Math.max(0, Math.min(1, firstFactor)),
        y: firstDelta.y * Math.max(0, Math.min(1, firstFactor)),
      },
      firstStart,
    ),
    firstFactor,
    secondFactor,
  };
}

export function removeConsecutiveDuplicates(
  coordinates: GeoCoordinate[],
  toleranceMeters = 0.5,
) {
  return coordinates.filter(
    (coordinate, index) =>
      index === 0 ||
      distanceInMeters(coordinates[index - 1], coordinate) > toleranceMeters,
  );
}

export function closeRing(coordinates: GeoCoordinate[]) {
  if (coordinates.length === 0) return [];
  const result = removeConsecutiveDuplicates(coordinates);
  if (distanceInMeters(result[0], result[result.length - 1]) > 0.5) {
    result.push({ ...result[0] });
  } else {
    result[result.length - 1] = { ...result[0] };
  }
  return result;
}

export function polygonAreaM2(coordinates: GeoCoordinate[]) {
  const ring = closeRing(coordinates);
  if (ring.length < 4) return 0;
  const reference = ring[0];
  const local = ring.map((coordinate) => toLocalPoint(coordinate, reference));
  let twiceArea = 0;

  for (let index = 0; index < local.length - 1; index += 1) {
    twiceArea +=
      local[index].x * local[index + 1].y -
      local[index + 1].x * local[index].y;
  }

  return Math.abs(twiceArea) / 2;
}

export function isSimplePolygon(coordinates: GeoCoordinate[]) {
  const ring = closeRing(coordinates);
  const segmentCount = ring.length - 1;
  if (segmentCount < 3) return false;

  for (let first = 0; first < segmentCount; first += 1) {
    for (let second = first + 1; second < segmentCount; second += 1) {
      const adjacent =
        second === first + 1 || (first === 0 && second === segmentCount - 1);
      if (adjacent) continue;

      const intersection = segmentIntersection(
        ring[first],
        ring[first + 1],
        ring[second],
        ring[second + 1],
      );
      if (intersection) return false;
    }
  }

  return true;
}

export function ringSignature(coordinates: GeoCoordinate[]) {
  const ring = closeRing(coordinates).slice(0, -1);
  const tokens = ring.map(
    (coordinate) =>
      `${coordinate.latitude.toFixed(5)},${coordinate.longitude.toFixed(5)}`,
  );
  if (tokens.length === 0) return "";

  const rotations = (values: string[]) =>
    values.map((_, index) =>
      [...values.slice(index), ...values.slice(0, index)].join("|"),
    );
  const candidates = [
    ...rotations(tokens),
    ...rotations([...tokens].reverse()),
  ];
  candidates.sort();
  return candidates[0];
}

export function toGeoJsonPolygon(
  coordinates: GeoCoordinate[],
): GeoJsonPolygon {
  const ring = closeRing(coordinates);
  return {
    type: "Polygon",
    coordinates: [
      ring.map((coordinate) => [coordinate.longitude, coordinate.latitude]),
    ],
  };
}

export function coordinateNodeId(coordinate: GeoCoordinate) {
  return `${coordinate.latitude.toFixed(6)}:${coordinate.longitude.toFixed(6)}`;
}
