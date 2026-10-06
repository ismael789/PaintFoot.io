import { ROAD_MATCHING_RULES, SENSOR_RULES } from "../config/territory";
import type {
  ConfidenceLevel,
  RawTrackPoint,
  RoadSegment,
  SensorEvidence,
  SensorSessionMetrics,
  TrackingSessionSummary,
} from "../types/game";
import { confidenceLevel } from "./sensor-metrics";
import { averageAvailableSignals } from "./sensor-capability-logic";
import {
  bearingDegrees,
  closestPointOnSegment,
  distanceInMeters,
  routeDistanceInMeters,
} from "../utils/geo";

export interface SensorAssistanceAnalysis {
  compassCompatible: boolean;
  confirmedTurn: boolean;
  geographicTurnDegrees: number;
  movementHeadingDegrees: number | null;
  moving: boolean;
  rotationSensorAvailable: boolean;
  significantRotation: boolean;
  headingConfidence: ConfidenceLevel;
  orientationConfidence: ConfidenceLevel;
  locationConfidence: ConfidenceLevel;
  movementConfidence: ConfidenceLevel;
  walkingConfidence: ConfidenceLevel;
  roadConfidence: ConfidenceLevel;
  captureConfidence: ConfidenceLevel;
  suspiciousMovement: boolean;
}

export function angularDistanceDegrees(first: number, second: number) {
  const difference = Math.abs(((first - second + 540) % 360) - 180);
  return difference;
}

export function cardinalDirection(headingDegrees: number | null) {
  if (headingDegrees === null || !Number.isFinite(headingDegrees)) return null;
  const directions = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  return directions[Math.round(((headingDegrees % 360) + 360) / 45) % 8];
}

function circularWeightedAverage(
  firstDegrees: number,
  firstWeight: number,
  secondDegrees: number,
  secondWeight: number,
) {
  const firstRadians = (firstDegrees * Math.PI) / 180;
  const secondRadians = (secondDegrees * Math.PI) / 180;
  const x =
    Math.cos(firstRadians) * firstWeight +
    Math.cos(secondRadians) * secondWeight;
  const y =
    Math.sin(firstRadians) * firstWeight +
    Math.sin(secondRadians) * secondWeight;
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function isFreshEvidence(evidence: SensorEvidence | undefined, now: number) {
  return (
    evidence !== undefined &&
    now - evidence.timestamp <= SENSOR_RULES.maximumEvidenceAgeMs
  );
}

function getGeographicHeadings(rawTrack: RawTrackPoint[]) {
  const usefulPoints = rawTrack.filter(
    (point, index) =>
      index === 0 ||
      distanceInMeters(rawTrack[index - 1], point) >= 2,
  );
  const last = usefulPoints[usefulPoints.length - 1];
  const previous = usefulPoints[usefulPoints.length - 2];
  const beforePrevious = usefulPoints[usefulPoints.length - 3];

  const reportedHeading =
    last?.heading !== undefined &&
    last.heading !== null &&
    last.heading >= 0 &&
    (last.speed === undefined ||
      last.speed === null ||
      last.speed >= SENSOR_RULES.minimumMovementSpeedMps)
      ? last.heading
      : null;
  const latestLegHeading =
    previous && last ? bearingDegrees(previous, last) : null;
  const priorLegHeading =
    beforePrevious && previous
      ? bearingDegrees(beforePrevious, previous)
      : null;

  return {
    current: reportedHeading ?? latestLegHeading,
    previous: priorLegHeading,
  };
}

export function analyzeSensorAssistance(
  rawTrack: RawTrackPoint[],
  now = Date.now(),
): SensorAssistanceAnalysis {
  const headings = getGeographicHeadings(rawTrack);
  const recentPoints = rawTrack.slice(-6);
  const recentEvidence = recentPoints
    .map((point) => point.sensor)
    .filter((evidence): evidence is SensorEvidence =>
      isFreshEvidence(evidence, now),
    );
  const latestEvidence = recentEvidence[recentEvidence.length - 1];
  const latestPoint = recentPoints[recentPoints.length - 1];
  const gyroscopeRate = Math.max(
    0,
    ...recentEvidence.map(
      (evidence) => evidence.gyroscopeRotationRateRadS ?? 0,
    ),
  );
  const deviceMotionRate = Math.max(
    0,
    ...recentEvidence.map(
      (evidence) => evidence.deviceMotionRotationRateDegS ?? 0,
    ),
  );
  const rotationHeadingChanges = recentEvidence
    .slice(1)
    .map((evidence, index) => {
      const previous = recentEvidence[index];
      const currentHeading =
        evidence.rotationVectorHeadingDegrees ??
        evidence.gameRotationVectorHeadingDegrees ??
        evidence.geomagneticRotationVectorHeadingDegrees;
      const previousHeading =
        previous.rotationVectorHeadingDegrees ??
        previous.gameRotationVectorHeadingDegrees ??
        previous.geomagneticRotationVectorHeadingDegrees;
      return currentHeading !== null &&
        currentHeading !== undefined &&
        previousHeading !== null &&
        previousHeading !== undefined
        ? angularDistanceDegrees(currentHeading, previousHeading)
        : 0;
    });
  const rotationVectorTurnDegrees = Math.max(0, ...rotationHeadingChanges);
  const significantRotation =
    gyroscopeRate >= SENSOR_RULES.significantGyroscopeRateRadS ||
    deviceMotionRate >= SENSOR_RULES.significantDeviceMotionRateDegS ||
    rotationVectorTurnDegrees >= SENSOR_RULES.significantGpsTurnDegrees;
  const rotationSensorAvailable = recentEvidence.some(
    (evidence) =>
      evidence.availability.gyroscope ||
      evidence.availability.deviceMotion ||
      evidence.availability.rotationVector ||
      evidence.availability.gameRotationVector ||
      evidence.availability.geomagneticRotationVector,
  );
  const geographicTurnDegrees =
    headings.current !== null && headings.previous !== null
      ? angularDistanceDegrees(headings.current, headings.previous)
      : 0;
  const moving =
    recentPoints.some(
      (point) =>
        point.speed !== undefined &&
        point.speed !== null &&
        point.speed >= SENSOR_RULES.minimumMovementSpeedMps,
    ) || recentEvidence.some((evidence) => evidence.moving === true);

  const calibratedMagneticField =
    latestEvidence?.magneticFieldMicrotesla ?? null;
  const magneticFieldReliable =
    latestEvidence?.magneticConfidence !== "low" &&
    (calibratedMagneticField === null ||
      (calibratedMagneticField >=
        SENSOR_RULES.minimumMagneticFieldMicrotesla &&
        calibratedMagneticField <=
          SENSOR_RULES.maximumMagneticFieldMicrotesla));
  const compassHeading =
    latestEvidence?.compassHeadingDegrees !== null &&
    latestEvidence?.compassHeadingDegrees !== undefined &&
    latestEvidence.compassAccuracy !== null &&
    latestEvidence.compassAccuracy >= SENSOR_RULES.minimumCompassAccuracy &&
    magneticFieldReliable
      ? latestEvidence.compassHeadingDegrees
      : null;
  const compassCompatible =
    headings.current !== null &&
    compassHeading !== null &&
    angularDistanceDegrees(headings.current, compassHeading) <=
      SENSOR_RULES.maximumCompassGpsDifferenceDegrees;
  const movementHeadingDegrees =
    headings.current !== null && compassCompatible && compassHeading !== null
      ? circularWeightedAverage(headings.current, 0.8, compassHeading, 0.2)
      : headings.current;

  const locationScore =
    latestPoint?.accuracy === null || latestPoint?.accuracy === undefined
      ? 0.5
      : Math.max(
          0,
          Math.min(
            1,
            1 -
              latestPoint.accuracy /
                (ROAD_MATCHING_RULES.searchRadiusMeters * 1.5),
          ),
        );
  const movementSignals: number[] = [];
  const gpsMovementAvailable = recentPoints.some(
    (point) => point.speed !== null && point.speed !== undefined,
  );
  if (gpsMovementAvailable) {
    movementSignals.push(
      recentPoints.some(
        (point) =>
          point.speed !== null &&
          point.speed !== undefined &&
          point.speed >= SENSOR_RULES.minimumMovementSpeedMps,
      )
        ? 1
        : 0.25,
    );
  }
  if (latestEvidence?.availability.accelerometer) {
    movementSignals.push(latestEvidence.moving ? 1 : 0.2);
  }
  if (latestEvidence?.availability.linearAcceleration) {
    movementSignals.push(
      (latestEvidence.linearAccelerationMps2 ?? 0) >=
        SENSOR_RULES.minimumLinearAccelerationMps2
        ? 1
        : 0.25,
    );
  }
  const sessionSteps = latestEvidence?.sessionStepCount ?? null;
  if (latestEvidence?.availability.pedometer) {
    movementSignals.push(sessionSteps !== null && sessionSteps > 0 ? 1 : 0.1);
  }
  const stepDetectorIncreased =
    (recentEvidence.at(-1)?.stepDetectorCount ?? 0) >
    (recentEvidence[0]?.stepDetectorCount ?? 0);
  if (latestEvidence?.availability.stepDetector) {
    movementSignals.push(stepDetectorIncreased ? 1 : 0.2);
  }
  if (
    latestEvidence?.availability.significantMotion &&
    latestEvidence.significantMotionDetected
  ) {
    movementSignals.push(0.9);
  }
  const movementScore = averageAvailableSignals(movementSignals);
  const routeDistance = routeDistanceInMeters(rawTrack);
  const suspiciousMovement = Boolean(
    latestEvidence?.availability.pedometer &&
      latestEvidence.availability.accelerometer &&
      routeDistance >= SENSOR_RULES.suspiciousDistanceWithoutStepsMeters &&
      (sessionSteps ?? 0) === 0 &&
      (!latestEvidence.availability.stepDetector ||
        (latestEvidence.stepDetectorCount ?? 0) === 0) &&
      latestEvidence.moving === false,
  );
  const walkingScore = suspiciousMovement
    ? Math.min(movementScore, 0.2)
    : movementScore;
  const headingSignals: number[] = [];
  if (headings.current !== null) headingSignals.push(0.8);
  if (latestEvidence?.availability.compass) {
    const magneticWeight =
      latestEvidence.magneticConfidence === "high"
        ? 1
        : latestEvidence.magneticConfidence === "medium"
          ? 0.55
          : 0.1;
    headingSignals.push(compassCompatible ? magneticWeight : magneticWeight * 0.2);
  }
  if (rotationSensorAvailable) {
    headingSignals.push(significantRotation === (geographicTurnDegrees >= SENSOR_RULES.significantGpsTurnDegrees) ? 0.9 : 0.35);
  }
  const absoluteRotationHeading =
    latestEvidence?.rotationVectorHeadingDegrees ??
    latestEvidence?.geomagneticRotationVectorHeadingDegrees ??
    null;
  if (headings.current !== null && absoluteRotationHeading !== null) {
    const difference = angularDistanceDegrees(
      headings.current,
      absoluteRotationHeading,
    );
    headingSignals.push(Math.max(0.1, 1 - difference / 90));
  }
  if (
    latestEvidence?.magneticConfidence === "low" &&
    latestEvidence.availability.gameRotationVector &&
    latestEvidence.gameRotationVectorHeadingDegrees !== null &&
    latestEvidence.gameRotationVectorHeadingDegrees !== undefined
  ) {
    headingSignals.push(significantRotation ? 0.9 : 0.75);
  }
  if (
    !latestEvidence?.availability.gyroscope &&
    latestEvidence?.availability.geomagneticRotationVector &&
    latestEvidence.geomagneticRotationVectorHeadingDegrees !== null &&
    latestEvidence.geomagneticRotationVectorHeadingDegrees !== undefined
  ) {
    headingSignals.push(0.7);
  }
  const headingScore = averageAvailableSignals(headingSignals);
  const roadScore = (locationScore * 2 + headingScore + (moving ? 0.8 : 0.5)) / 4;
  const captureScore = suspiciousMovement
    ? Math.min(0.35, (locationScore + roadScore + walkingScore) / 3)
    : (locationScore + roadScore + walkingScore) / 3;

  return {
    compassCompatible,
    confirmedTurn:
      moving &&
      significantRotation &&
      geographicTurnDegrees >= SENSOR_RULES.significantGpsTurnDegrees,
    geographicTurnDegrees,
    movementHeadingDegrees,
    moving,
    rotationSensorAvailable,
    significantRotation,
    headingConfidence: confidenceLevel(headingScore),
    orientationConfidence: confidenceLevel(headingScore),
    locationConfidence: confidenceLevel(locationScore),
    movementConfidence: confidenceLevel(movementScore),
    walkingConfidence: confidenceLevel(walkingScore),
    roadConfidence: confidenceLevel(roadScore),
    captureConfidence: confidenceLevel(captureScore),
    suspiciousMovement,
  };
}

export function createTrackingSessionSummary({
  rawTrack,
  metrics,
  startedAt,
  endedAt,
  territoriesCaptured,
  areaCapturedM2,
  dailySteps,
}: {
  rawTrack: RawTrackPoint[];
  metrics: SensorSessionMetrics;
  startedAt: number;
  endedAt: number;
  territoriesCaptured: number;
  areaCapturedM2: number;
  dailySteps: number;
}): TrackingSessionSummary {
  const analysis = analyzeSensorAssistance(rawTrack, endedAt);
  return {
    id: `${startedAt}-${endedAt}`,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    distanceMeters: routeDistanceInMeters(rawTrack),
    steps: metrics.steps,
    dailySteps,
    territoriesCaptured,
    areaCapturedM2,
    ascentMeters: metrics.ascentMeters,
    descentMeters: metrics.descentMeters,
    walkingConfidence: analysis.walkingConfidence,
    movementConfidence: analysis.movementConfidence,
    roadConfidence: analysis.roadConfidence,
    suspiciousMovement: analysis.suspiciousMovement,
  };
}

export function getMapMatchingTurnPenalty(rawTrack: RawTrackPoint[]) {
  return analyzeSensorAssistance(rawTrack).confirmedTurn
    ? SENSOR_RULES.confirmedTurnPenaltyFactor
    : SENSOR_RULES.straightTurnPenaltyFactor;
}

function distanceToRoad(point: RawTrackPoint, segment: RoadSegment) {
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < segment.coordinates.length - 1; index += 1) {
    nearestDistance = Math.min(
      nearestDistance,
      closestPointOnSegment(
        point,
        segment.coordinates[index],
        segment.coordinates[index + 1],
      ).distanceMeters,
    );
  }
  return nearestDistance;
}

function segmentHeading(segment: RoadSegment) {
  if (segment.endHeading !== undefined) return segment.endHeading;
  const coordinates = segment.coordinates;
  if (coordinates.length < 2) return null;
  return bearingDegrees(
    coordinates[coordinates.length - 2],
    coordinates[coordinates.length - 1],
  );
}

function candidateScore(
  distanceMeters: number,
  headingDegrees: number | null,
  analysis: SensorAssistanceAnalysis,
  isCurrentRoad: boolean,
) {
  const confidenceWeight = (confidence: ConfidenceLevel) =>
    confidence === "high" ? 1 : confidence === "medium" ? 0.55 : 0.2;
  const headingCompatibility =
    headingDegrees !== null && analysis.movementHeadingDegrees !== null
      ? 1 -
        angularDistanceDegrees(
          headingDegrees,
          analysis.movementHeadingDegrees,
        ) /
          180
      : 0.5;
  return (
    -Math.min(distanceMeters, ROAD_MATCHING_RULES.searchRadiusMeters) *
      SENSOR_RULES.weights.gpsDistance *
      confidenceWeight(analysis.locationConfidence) +
    headingCompatibility *
      SENSOR_RULES.weights.heading *
      confidenceWeight(analysis.headingConfidence) +
    (isCurrentRoad
      ? SENSOR_RULES.weights.roadContinuity *
        (analysis.locationConfidence === "low" ? 1.35 : 1)
      : 0) +
    (!isCurrentRoad && analysis.confirmedTurn
      ? SENSOR_RULES.weights.confirmedTurn
      : 0)
  );
}

export function shouldAcceptRoadTransition(
  currentRoad: RoadSegment | undefined,
  matchedRoad: RoadSegment | undefined,
  rawTrack: RawTrackPoint[],
) {
  if (!currentRoad || !matchedRoad) return true;
  if (
    currentRoad.id === matchedRoad.id ||
    (currentRoad.wayId !== null && currentRoad.wayId === matchedRoad.wayId)
  ) {
    return true;
  }

  const analysis = analyzeSensorAssistance(rawTrack);
  // Sin giroscopio/DeviceMotion se conserva exactamente el flujo GPS + Valhalla.
  if (!analysis.rotationSensorAvailable) return true;

  const lastPoint = rawTrack[rawTrack.length - 1];
  if (!lastPoint) return true;
  const currentDistance = distanceToRoad(lastPoint, currentRoad);
  const matchedDistance = distanceToRoad(lastPoint, matchedRoad);
  if (
    currentDistance - matchedDistance >
    SENSOR_RULES.maximumProtectedParallelJumpMeters
  ) {
    return true;
  }

  const currentScore = candidateScore(
    currentDistance,
    segmentHeading(currentRoad),
    analysis,
    true,
  );
  const matchedScore = candidateScore(
    matchedDistance,
    segmentHeading(matchedRoad),
    analysis,
    false,
  );
  return matchedScore >= currentScore + SENSOR_RULES.transitionScoreMargin;
}
