export interface GeoCoordinate {
  latitude: number;
  longitude: number;
  timestamp?: number;
  roadSegmentId?: string;
  roadWayId?: string | null;
}

export interface RawTrackPoint extends GeoCoordinate {
  accuracy: number | null;
  heading?: number | null;
  speed?: number | null;
  sensor?: SensorEvidence;
}

export interface SensorAvailability {
  accelerometer: boolean;
  barometer?: boolean;
  compass: boolean;
  deviceMotion: boolean;
  gyroscope: boolean;
  lightSensor?: boolean;
  magnetometer: boolean;
  pedometer?: boolean;
  proximity?: boolean;
  gravity?: boolean;
  linearAcceleration?: boolean;
  rotationVector?: boolean;
  gameRotationVector?: boolean;
  geomagneticRotationVector?: boolean;
  stepDetector?: boolean;
  significantMotion?: boolean;
  uncalibratedMagnetometer?: boolean;
}

export type ConfidenceLevel = "low" | "medium" | "high";
export type ThemePreference = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

export interface SensorEvidence {
  timestamp: number;
  availability: SensorAvailability;
  compassAccuracy: number | null;
  compassHeadingDegrees: number | null;
  gyroscopeRotationRateRadS: number | null;
  deviceMotionRotationRateDegS: number | null;
  accelerationDeltaG: number | null;
  magneticFieldMicrotesla: number | null;
  rawMagneticFieldMicrotesla?: number | null;
  magneticFieldInstabilityMicrotesla?: number | null;
  magneticConfidence?: ConfidenceLevel;
  sessionStepCount?: number | null;
  dailyStepCount?: number | null;
  pressureHpa?: number | null;
  relativeElevationMeters?: number | null;
  ascentMeters?: number;
  descentMeters?: number;
  ambientLightLux?: number | null;
  proximityNear?: boolean | null;
  probablePocket?: boolean;
  gravityVectorMps2?: { x: number; y: number; z: number } | null;
  linearAccelerationMps2?: number | null;
  rotationVectorHeadingDegrees?: number | null;
  gameRotationVectorHeadingDegrees?: number | null;
  geomagneticRotationVectorHeadingDegrees?: number | null;
  stepDetectorCount?: number | null;
  significantMotionDetected?: boolean;
  moving: boolean | null;
}

export interface SensorSessionMetrics {
  steps: number | null;
  dailySteps: number | null;
  pressureHpa: number | null;
  elevationDeltaMeters: number | null;
  ascentMeters: number | null;
  descentMeters: number | null;
  magneticConfidence: ConfidenceLevel;
}

export interface TrackingSessionSummary {
  id: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  distanceMeters: number;
  steps: number | null;
  dailySteps: number;
  territoriesCaptured: number;
  areaCapturedM2: number;
  ascentMeters: number | null;
  descentMeters: number | null;
  walkingConfidence: ConfidenceLevel;
  movementConfidence: ConfidenceLevel;
  roadConfidence: ConfidenceLevel;
  suspiciousMovement: boolean;
}

export interface GeoJsonPolygon {
  type: "Polygon";
  coordinates: number[][][];
}

export interface TerritoryShield {
  startedAt: number;
  expiresAt: number;
  durationHours: number;
  source?: "free" | "stripe";
  paymentId?: string | null;
}

export interface Territory {
  id: string;
  playerId: string;
  playerColor: string;
  polygon: GeoJsonPolygon;
  areaM2: number;
  createdAt: number;
  signature: string;

  // Se conservan estos nombres para no romper el render y el protocolo existentes.
  coordinates: GeoCoordinate[];
  color: string;
  owner: string;
  shield?: TerritoryShield | null;
  status?: TerritoryStatus;
  globalOwnerId?: string;
  targetTerritoryId?: string | null;
  regionIds?: string[];
  captureSessionId?: string | null;
}

export type TerritoryStatus =
  | "confirmed"
  | "protected"
  | "vulnerable"
  | "pending_validation"
  | "pending_global_sync"
  | "pending_capture"
  | "disputed"
  | "captured"
  | "rejected";

export interface PlayerProfile {
  id: string;
  name: string;
  color: string;
  globalId?: string;
}

export interface NearbyPlayer {
  id: string;
  name: string;
  color: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  heading: number | null;
  speed: number | null;
  regionId: string;
  updatedAt: number;
  trail?: GeoCoordinate[];
}

export interface RoadSegment {
  id: string;
  wayId: string | null;
  name: string | null;
  coordinates: GeoCoordinate[];
  startNodeId: string;
  endNodeId: string;
  intersectingEdgeCount: number;
  endNodeType: string | null;
  beginHeading?: number;
  endHeading?: number;
}

export interface RoadNode {
  id: string;
  coordinate: GeoCoordinate;
  segmentIds: string[];
  externalConnectionCount: number;
  type: string | null;
}

export interface RoadGraph {
  nodes: RoadNode[];
  segments: RoadSegment[];
  intersectionCount: number;
}
