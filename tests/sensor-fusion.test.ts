import assert from "node:assert/strict";
import test from "node:test";

import { SENSOR_RULES } from "../src/config/territory";
import {
  analyzeSensorAssistance,
  cardinalDirection,
  createTrackingSessionSummary,
  getMapMatchingTurnPenalty,
  shouldAcceptRoadTransition,
} from "../src/services/sensor-fusion";
import { AmbientThemeController } from "../src/services/sensor-metrics";
import type {
  GeoCoordinate,
  RawTrackPoint,
  RoadSegment,
  SensorEvidence,
} from "../src/types/game";

const ORIGIN = { latitude: 29.0729, longitude: -110.9559 };

function point(eastMeters: number, northMeters: number): GeoCoordinate {
  return {
    latitude: ORIGIN.latitude + northMeters / 111_320,
    longitude:
      ORIGIN.longitude +
      eastMeters / (111_320 * Math.cos((ORIGIN.latitude * Math.PI) / 180)),
  };
}

function segment(
  id: string,
  start: GeoCoordinate,
  end: GeoCoordinate,
  heading: number,
): RoadSegment {
  return {
    id,
    wayId: id,
    name: null,
    coordinates: [start, end],
    startNodeId: `${id}-start`,
    endNodeId: `${id}-end`,
    intersectingEdgeCount: 0,
    endNodeType: null,
    beginHeading: heading,
    endHeading: heading,
  };
}

function evidence(
  gyroscopeRotationRateRadS: number,
  compassHeadingDegrees = 90,
): SensorEvidence {
  return {
    timestamp: Date.now(),
    availability: {
      accelerometer: true,
      compass: true,
      deviceMotion: true,
      gyroscope: true,
      magnetometer: true,
    },
    compassAccuracy: 3,
    compassHeadingDegrees,
    gyroscopeRotationRateRadS,
    deviceMotionRotationRateDegS: gyroscopeRotationRateRadS * 57.2958,
    accelerationDeltaG: 0.1,
    magneticFieldMicrotesla: 45,
    moving: true,
  };
}

function raw(
  eastMeters: number,
  northMeters: number,
  sensor?: SensorEvidence,
): RawTrackPoint {
  return {
    ...point(eastMeters, northMeters),
    accuracy: 5,
    speed: 1.5,
    sensor,
  };
}

function completeEvidence(
  overrides: Partial<SensorEvidence> = {},
): SensorEvidence {
  return {
    ...evidence(0.1),
    availability: {
      accelerometer: true,
      barometer: true,
      compass: true,
      deviceMotion: true,
      gyroscope: true,
      lightSensor: true,
      magnetometer: true,
      pedometer: true,
      proximity: true,
      gravity: true,
      linearAcceleration: true,
      rotationVector: true,
      gameRotationVector: true,
      geomagneticRotationVector: true,
      stepDetector: true,
      significantMotion: true,
      uncalibratedMagnetometer: true,
    },
    magneticConfidence: "high",
    rawMagneticFieldMicrotesla: 47,
    magneticFieldInstabilityMicrotesla: 2,
    sessionStepCount: 50,
    pressureHpa: 1_010,
    relativeElevationMeters: 3,
    ascentMeters: 3,
    descentMeters: 0,
    ambientLightLux: 300,
    proximityNear: false,
    probablePocket: false,
    gravityVectorMps2: { x: 0, y: 0, z: 9.81 },
    linearAccelerationMps2: 1.2,
    rotationVectorHeadingDegrees: 90,
    gameRotationVectorHeadingDegrees: 25,
    geomagneticRotationVectorHeadingDegrees: 90,
    stepDetectorCount: 50,
    significantMotionDetected: false,
    ...overrides,
  };
}

test("integracion A: datos coherentes de todos los sensores dan confianza alta", () => {
  const sensor = completeEvidence();
  const analysis = analyzeSensorAssistance([
    raw(0, 0, sensor),
    raw(20, 0, sensor),
    raw(40, 0, sensor),
  ]);

  assert.equal(analysis.locationConfidence, "high");
  assert.equal(analysis.walkingConfidence, "high");
  assert.equal(analysis.headingConfidence, "high");
  assert.equal(analysis.roadConfidence, "high");
  assert.equal(analysis.captureConfidence, "high");
  assert.equal(analysis.trackingReliability, "high");
  assert.equal(analysis.magneticConfidence, "high");
  assert.equal(analysis.pocketState, "not-in-pocket");
  assert.equal(analysis.sensorAvailability.gyroscope, true);
});

test("integracion B: GPS impreciso reduce confianza sin cancelar el recorrido", () => {
  const sensor = completeEvidence();
  const track = [raw(0, 0, sensor), raw(20, 0, sensor)];
  track[1].accuracy = 50;
  const analysis = analyzeSensorAssistance(track);

  assert.equal(analysis.locationConfidence, "low");
  assert.notEqual(analysis.captureConfidence, "high");
  assert.equal(analysis.suspiciousMovement, false);
});

test("integracion C: interferencia magnetica reduce el peso de la brujula", () => {
  const reliable = completeEvidence();
  const interfered = completeEvidence({
    magneticConfidence: "low",
    rawMagneticFieldMicrotesla: 180,
    compassHeadingDegrees: 270,
  });
  const reliableAnalysis = analyzeSensorAssistance([
    raw(0, 0, reliable),
    raw(20, 0, reliable),
  ]);
  const interferedAnalysis = analyzeSensorAssistance([
    raw(0, 0, interfered),
    raw(20, 0, interfered),
  ]);

  assert.equal(reliableAnalysis.headingConfidence, "high");
  assert.notEqual(interferedAnalysis.headingConfidence, "high");
  assert.ok(
    Math.abs((interferedAnalysis.movementHeadingDegrees ?? 0) - 90) < 0.01,
  );
});

test("integracion D: distancia sin pasos ni movimiento se marca sospechosa", () => {
  const sensor = completeEvidence({
    sessionStepCount: 0,
    stepDetectorCount: 0,
    moving: false,
    accelerationDeltaG: 0,
    linearAccelerationMps2: 0,
  });
  const analysis = analyzeSensorAssistance([
    raw(0, 0, sensor),
    raw(600, 0, sensor),
  ]);
  assert.equal(analysis.suspiciousMovement, true);
  assert.equal(analysis.walkingConfidence, "low");
});

test("sensores nuevos 3: gravedad y aceleracion lineal separan movimiento", () => {
  const sensor = completeEvidence({
    moving: true,
    gravityVectorMps2: { x: 0, y: 0, z: 9.81 },
    linearAccelerationMps2: 1.4,
  });
  const analysis = analyzeSensorAssistance([
    raw(0, 0, sensor),
    raw(15, 0, sensor),
  ]);
  assert.equal(analysis.movementConfidence, "high");
});

test("sensores nuevos 4: rotation vector coherente aumenta orientacion", () => {
  const sensor = completeEvidence({
    compassHeadingDegrees: 90,
    rotationVectorHeadingDegrees: 90,
  });
  const analysis = analyzeSensorAssistance([
    raw(0, 0, sensor),
    raw(20, 0, sensor),
  ]);
  assert.equal(analysis.orientationConfidence, "high");
});

test("sensores nuevos 5: game rotation apoya con interferencia magnetica", () => {
  const sensor = completeEvidence({
    magneticConfidence: "low",
    compassHeadingDegrees: 270,
    gameRotationVectorHeadingDegrees: 20,
  });
  const analysis = analyzeSensorAssistance([
    raw(0, 0, sensor),
    raw(20, 0, sensor),
  ]);
  assert.notEqual(analysis.orientationConfidence, "low");
  assert.ok(Math.abs((analysis.movementHeadingDegrees ?? 0) - 90) < 0.01);
});

test("sensores nuevos 6: vector geomagnetico funciona sin giroscopio", () => {
  const sensor = completeEvidence({
    availability: {
      ...completeEvidence().availability,
      gyroscope: false,
      deviceMotion: false,
      rotationVector: false,
      gameRotationVector: false,
      geomagneticRotationVector: true,
    },
    gyroscopeRotationRateRadS: null,
    deviceMotionRotationRateDegS: null,
    geomagneticRotationVectorHeadingDegrees: 90,
  });
  const analysis = analyzeSensorAssistance([
    raw(0, 0, sensor),
    raw(20, 0, sensor),
  ]);
  assert.notEqual(analysis.orientationConfidence, "low");
  assert.equal(analysis.rotationSensorAvailable, true);
});

test("sensores nuevos 7: step detector y podometro coherentes confirman caminata", () => {
  const first = completeEvidence({ sessionStepCount: 10, stepDetectorCount: 10 });
  const last = completeEvidence({ sessionStepCount: 14, stepDetectorCount: 14 });
  const analysis = analyzeSensorAssistance([
    raw(0, 0, first),
    raw(20, 0, last),
  ]);
  assert.equal(analysis.walkingConfidence, "high");
});

test("sensores nuevos 8: GPS sin pasos ni aceleracion reduce caminata", () => {
  const sensor = completeEvidence({
    sessionStepCount: 0,
    stepDetectorCount: 0,
    accelerationDeltaG: 0,
    linearAccelerationMps2: 0,
    moving: false,
  });
  const analysis = analyzeSensorAssistance([
    raw(0, 0, sensor),
    raw(600, 0, sensor),
  ]);
  assert.equal(analysis.walkingConfidence, "low");
});

test("sensores nuevos 9: significant motion reanuda estado de movimiento", () => {
  const sensor = completeEvidence({
    significantMotionDetected: true,
    moving: true,
  });
  const analysis = analyzeSensorAssistance([
    raw(0, 0, sensor),
    raw(10, 0, sensor),
  ]);
  assert.equal(analysis.moving, true);
  assert.equal(analysis.movementConfidence, "high");
});

test("integracion E: un giro real conserva la confirmacion vial", () => {
  const turning = completeEvidence({
    compassHeadingDegrees: 0,
    gyroscopeRotationRateRadS: 1,
    deviceMotionRotationRateDegS: 57,
  });
  const analysis = analyzeSensorAssistance([
    raw(0, 0, turning),
    raw(40, 0, turning),
    raw(40, 15, turning),
  ]);
  assert.equal(analysis.confirmedTurn, true);
});

test("integracion F: la luz solo resuelve el tema y no altera captura", () => {
  const controller = new AmbientThemeController("dark");
  controller.update("auto", 500, 0);
  assert.equal(controller.update("auto", 500, 6_000), "light");

  const sensor = completeEvidence({ ambientLightLux: 0 });
  const darkAnalysis = analyzeSensorAssistance([
    raw(0, 0, sensor),
    raw(20, 0, sensor),
  ]);
  sensor.ambientLightLux = 50_000;
  const brightAnalysis = analyzeSensorAssistance([
    raw(0, 0, sensor),
    raw(20, 0, sensor),
  ]);
  assert.equal(darkAnalysis.captureConfidence, brightAnalysis.captureConfidence);
});

test("integracion G: sin barometro el resumen y la conquista siguen disponibles", () => {
  const sensor = completeEvidence({
    availability: {
      ...completeEvidence().availability,
      barometer: false,
    },
    pressureHpa: null,
    relativeElevationMeters: null,
  });
  const track = [raw(0, 0, sensor), raw(20, 0, sensor)];
  const summary = createTrackingSessionSummary({
    rawTrack: track,
    metrics: {
      steps: 25,
      dailySteps: null,
      pressureHpa: null,
      elevationDeltaMeters: null,
      ascentMeters: null,
      descentMeters: null,
      magneticConfidence: "high",
    },
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    territoriesCaptured: 1,
    areaCapturedM2: 300,
    dailySteps: 25,
  });
  assert.equal(summary.territoriesCaptured, 1);
  assert.equal(summary.ascentMeters, null);
  assert.equal(summary.magneticConfidence, "high");
  assert.equal(summary.sensorAvailability.barometer, false);
  assert.equal(summary.pocketState, "not-in-pocket");
});

test("integracion H: la ausencia de un sensor no reserva peso ni detiene fusion", () => {
  const sensor = completeEvidence({
    availability: {
      ...completeEvidence().availability,
      uncalibratedMagnetometer: false,
    },
    rawMagneticFieldMicrotesla: null,
    magneticFieldInstabilityMicrotesla: null,
    magneticConfidence: "high",
  });
  const analysis = analyzeSensorAssistance([
    raw(0, 0, sensor),
    raw(20, 0, sensor),
  ]);
  assert.equal(analysis.captureConfidence, "high");
});

test("prueba G: un salto GPS paralelo sin giro conserva la calle continua", () => {
  const currentRoad = segment("actual", point(0, 0), point(100, 0), 90);
  const parallelRoad = segment("paralela", point(0, 8), point(100, 8), 90);
  const track = [raw(0, 0), raw(40, 0), raw(80, 8, evidence(0.1))];

  assert.equal(
    shouldAcceptRoadTransition(currentRoad, parallelRoad, track),
    false,
  );
  assert.equal(getMapMatchingTurnPenalty(track), 500);
});

test("prueba H: giro geografico de 90 grados confirmado por sensores cambia de calle", () => {
  const currentRoad = segment("este", point(0, 0), point(100, 0), 90);
  const turnedRoad = segment("norte", point(40, 0), point(40, 100), 0);
  const track = [raw(0, 0), raw(40, 0), raw(40, 8, evidence(1, 0))];
  const analysis = analyzeSensorAssistance(track);

  assert.equal(analysis.confirmedTurn, true);
  assert.equal(
    shouldAcceptRoadTransition(currentRoad, turnedRoad, track),
    true,
  );
  assert.equal(
    getMapMatchingTurnPenalty(track),
    SENSOR_RULES.confirmedTurnPenaltyFactor,
  );
});

test("prueba I: girar el telefono mientras se camina recto no cambia de calle", () => {
  const currentRoad = segment("actual", point(0, 0), point(100, 0), 90);
  const parallelRoad = segment("paralela", point(0, 8), point(100, 8), 90);
  const track = [raw(0, 0), raw(40, 0), raw(80, 8, evidence(2))];
  const analysis = analyzeSensorAssistance(track);

  assert.equal(analysis.significantRotation, true);
  assert.equal(analysis.confirmedTurn, false);
  assert.equal(
    shouldAcceptRoadTransition(currentRoad, parallelRoad, track),
    false,
  );
});

test("prueba J: sin giroscopio se mantiene el fallback GPS y Map Matching", () => {
  const currentRoad = segment("actual", point(0, 0), point(100, 0), 90);
  const candidateRoad = segment("candidata", point(40, 0), point(40, 100), 0);
  const track = [raw(0, 0), raw(40, 0), raw(40, 8)];

  assert.equal(
    shouldAcceptRoadTransition(currentRoad, candidateRoad, track),
    true,
  );
});

test("la brujula convierte el rumbo en puntos cardinales", () => {
  assert.equal(cardinalDirection(0), "N");
  assert.equal(cardinalDirection(90), "E");
  assert.equal(cardinalDirection(180), "S");
  assert.equal(cardinalDirection(270), "O");
});
