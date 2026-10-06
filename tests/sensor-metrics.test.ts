import assert from "node:assert/strict";
import test from "node:test";

import {
  AmbientThemeController,
  calculateMagneticConfidence,
  detectProbablePocket,
  pressureToRelativeAltitudeMeters,
  SensorSessionAccumulator,
} from "../src/services/sensor-metrics";
import { analyzeSensorAssistance } from "../src/services/sensor-fusion";
import type { RawTrackPoint, SensorEvidence } from "../src/types/game";

const ORIGIN = { latitude: 29.0729, longitude: -110.9559 };

function rawPoint(eastMeters: number, sensor?: SensorEvidence): RawTrackPoint {
  return {
    latitude: ORIGIN.latitude,
    longitude:
      ORIGIN.longitude +
      eastMeters /
        (111_320 * Math.cos((ORIGIN.latitude * Math.PI) / 180)),
    accuracy: 5,
    speed: 1.5,
    sensor,
  };
}

function stationaryEvidence(): SensorEvidence {
  return {
    timestamp: Date.now(),
    availability: {
      accelerometer: true,
      compass: false,
      deviceMotion: false,
      gyroscope: false,
      magnetometer: false,
      pedometer: true,
    },
    compassAccuracy: null,
    compassHeadingDegrees: null,
    gyroscopeRotationRateRadS: null,
    deviceMotionRotationRateDegS: null,
    accelerationDeltaG: 0.01,
    magneticFieldMicrotesla: null,
    sessionStepCount: 0,
    moving: false,
  };
}

test("podometro: los pasos acumulados nunca retroceden", () => {
  const accumulator = new SensorSessionAccumulator();
  accumulator.updateSteps(8);
  accumulator.updateSteps(4);
  accumulator.updateSteps(12);
  assert.equal(accumulator.getMetrics().steps, 12);
});

test("podometro: guarda pasos de sesion y del dia", () => {
  const accumulator = new SensorSessionAccumulator();
  accumulator.updateSteps(125);
  accumulator.updateDailySteps(3_500);
  assert.equal(accumulator.getMetrics().steps, 125);
  assert.equal(accumulator.getMetrics().dailySteps, 3_500);
});

test("podometro: sin sensor se conserva el fallback GPS", () => {
  const analysis = analyzeSensorAssistance([
    rawPoint(0),
    rawPoint(20),
  ]);
  assert.equal(analysis.moving, true);
  assert.equal(analysis.suspiciousMovement, false);
});

test("podometro: distancia extensa sin pasos ni aceleracion baja la confianza", () => {
  const sensor = stationaryEvidence();
  const analysis = analyzeSensorAssistance([
    rawPoint(0),
    rawPoint(600, sensor),
  ]);
  assert.equal(analysis.suspiciousMovement, true);
  assert.equal(analysis.walkingConfidence, "low");
});

test("barometro: un cambio real acumula subida y bajada", () => {
  const accumulator = new SensorSessionAccumulator();
  accumulator.updatePressure(1_013.25, 0);
  accumulator.updatePressure(1_012.8, 5);
  accumulator.updatePressure(1_013.1, 2);
  assert.equal(accumulator.getMetrics().ascentMeters, 5);
  assert.equal(accumulator.getMetrics().descentMeters, 3);
});

test("barometro: el ruido pequeno no suma desnivel", () => {
  const accumulator = new SensorSessionAccumulator();
  accumulator.updatePressure(1_013.25);
  accumulator.updatePressure(1_013.24);
  accumulator.updatePressure(1_013.26);
  assert.equal(accumulator.getMetrics().ascentMeters, 0);
  assert.equal(accumulator.getMetrics().descentMeters, 0);
});

test("barometro: convierte presion a altura relativa", () => {
  assert.ok(pressureToRelativeAltitudeMeters(1_000, 1_013.25) > 100);
});

test("barometro: sin lecturas reporta fallback no disponible", () => {
  const accumulator = new SensorSessionAccumulator();
  assert.equal(accumulator.getMetrics().pressureHpa, null);
  assert.equal(accumulator.getMetrics().ascentMeters, null);
});

test("luz: luminosidad alta persistente activa tema claro", () => {
  const controller = new AmbientThemeController("dark");
  controller.update("auto", 500, 0);
  assert.equal(controller.update("auto", 500, 6_000), "light");
});

test("luz: luminosidad baja persistente activa tema oscuro", () => {
  const controller = new AmbientThemeController("light");
  controller.update("auto", 2, 0);
  assert.equal(controller.update("auto", 2, 6_000), "dark");
});

test("luz: un cambio breve no produce parpadeo de tema", () => {
  const controller = new AmbientThemeController("dark");
  controller.update("auto", 500, 0);
  assert.equal(controller.update("auto", 500, 2_000), "dark");
});

test("luz: la seleccion manual tiene prioridad absoluta", () => {
  const controller = new AmbientThemeController("dark");
  assert.equal(controller.update("light", 0, 10_000), "light");
  assert.equal(controller.update("dark", 50_000, 20_000), "dark");
});

test("proximidad: cerca y cero lux detectan bolsillo sin cambiar tema", () => {
  const controller = new AmbientThemeController("light");
  assert.equal(detectProbablePocket(0, true), true);
  controller.update("auto", 0, 0, true);
  assert.equal(controller.update("auto", 0, 10_000, true), "light");
});

test("proximidad: lejos permite evaluar oscuridad persistente", () => {
  const controller = new AmbientThemeController("light");
  assert.equal(detectProbablePocket(0, false), false);
  controller.update("auto", 0, 0, false);
  assert.equal(controller.update("auto", 0, 6_000, false), "dark");
});

test("magnetometro sin calibrar: campo normal y estable da confianza alta", () => {
  assert.equal(
    calculateMagneticConfidence({
      calibratedFieldMicrotesla: 46,
      rawFieldMicrotesla: 48,
      rawInstabilityMicrotesla: 2,
      compassAccuracy: 3,
    }),
    "high",
  );
});

test("magnetometro sin calibrar: interferencia baja la confianza", () => {
  assert.equal(
    calculateMagneticConfidence({
      calibratedFieldMicrotesla: 45,
      rawFieldMicrotesla: 170,
      rawInstabilityMicrotesla: 30,
      compassAccuracy: 3,
    }),
    "low",
  );
});

test("magnetometro sin calibrar: ausente usa precision de brujula como fallback", () => {
  assert.equal(
    calculateMagneticConfidence({
      calibratedFieldMicrotesla: null,
      rawFieldMicrotesla: null,
      rawInstabilityMicrotesla: null,
      compassAccuracy: 2,
    }),
    "high",
  );
});
