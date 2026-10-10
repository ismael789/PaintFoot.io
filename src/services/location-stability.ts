import type { GeoCoordinate } from "../types/game";
import { distanceInMeters } from "../utils/geo";

export interface StableGpsPoint extends GeoCoordinate {
  timestamp?: number;
}

interface StabilityOptions {
  accuracyMeters: number | null | undefined;
  reportedSpeedMps: number | null | undefined;
  sensorMoving?: boolean | null;
  tracking: boolean;
  baseDistanceMeters: number;
  maximumSpeedMps: number;
}

export function minimumStableGpsDistance(options: StabilityOptions) {
  const accuracy = Math.max(0, options.accuracyMeters ?? 10);
  const speed = options.reportedSpeedMps;
  const movementConfirmed =
    options.sensorMoving === true ||
    (speed !== null && speed !== undefined && speed >= 0.7);
  const stationary =
    !movementConfirmed &&
    (options.sensorMoving === false ||
      (speed !== null && speed !== undefined && speed >= 0 && speed < 0.4));

  if (movementConfirmed) {
    return options.tracking
      ? options.baseDistanceMeters
      : Math.max(options.baseDistanceMeters, 4);
  }
  if (stationary) {
    return Math.max(
      options.tracking ? 12 : 15,
      Math.min(25, accuracy * 1.1),
    );
  }
  return options.tracking
    ? Math.max(options.baseDistanceMeters, Math.min(6, accuracy * 0.3))
    : Math.max(options.baseDistanceMeters, Math.min(12, accuracy * 0.5));
}

export function shouldAcceptStableGpsUpdate(
  previous: StableGpsPoint | null,
  next: StableGpsPoint,
  options: StabilityOptions,
) {
  if (!previous) return true;
  const distance = distanceInMeters(previous, next);
  if (distance < minimumStableGpsDistance(options)) return false;

  if (previous.timestamp !== undefined && next.timestamp !== undefined) {
    const elapsedSeconds = (next.timestamp - previous.timestamp) / 1_000;
    if (
      elapsedSeconds > 0 &&
      distance / elapsedSeconds > options.maximumSpeedMps
    ) {
      return false;
    }
  }
  return true;
}
