import assert from "node:assert/strict";
import test from "node:test";

import {
  averageAvailableSignals,
  canUseTerritoryTracking,
  resolveCapabilityStatus,
} from "../src/services/sensor-capability-logic";

test("prueba 10: sensor inexistente queda no disponible", () => {
  assert.equal(
    resolveCapabilityStatus({
      requiresNativeModule: true,
      nativeModuleAvailable: true,
      detected: false,
      active: false,
    }),
    "unavailable",
  );
});

test("prueba 11: hardware detectado se muestra disponible", () => {
  assert.equal(
    resolveCapabilityStatus({
      requiresNativeModule: true,
      nativeModuleAvailable: true,
      detected: true,
      active: false,
    }),
    "available",
  );
});

test("prueba 12: hardware ausente se muestra no disponible", () => {
  assert.equal(
    resolveCapabilityStatus({
      requiresNativeModule: true,
      nativeModuleAvailable: true,
      detected: false,
      active: false,
    }),
    "unavailable",
  );
});

test("prueba 13: sensor existente sin recorrido aparece inactivo", () => {
  assert.equal(
    resolveCapabilityStatus({
      requiresNativeModule: false,
      nativeModuleAvailable: true,
      detected: true,
      active: false,
    }),
    "available",
  );
});

test("prueba 14: sensor usado durante recorrido aparece activo", () => {
  assert.equal(
    resolveCapabilityStatus({
      requiresNativeModule: true,
      nativeModuleAvailable: true,
      detected: true,
      active: true,
    }),
    "active",
  );
});

test("prueba 15: modulo nativo dentro de Expo Go aparece solo APK", () => {
  assert.equal(
    resolveCapabilityStatus({
      requiresNativeModule: true,
      nativeModuleAvailable: false,
      detected: null,
      active: false,
    }),
    "apk-only",
  );
});

test("prueba 16: APK con hardware nativo puede marcarlo activo", () => {
  assert.equal(
    resolveCapabilityStatus({
      requiresNativeModule: true,
      nativeModuleAvailable: true,
      detected: true,
      active: true,
    }),
    "active",
  );
});

test("prueba 17: falta barometro y las otras senales mantienen confianza", () => {
  assert.equal(averageAvailableSignals([1, 0.8, null]), 0.9);
});

test("prueba 18: falta proximidad y la luz permanece utilizable", () => {
  assert.equal(averageAvailableSignals([1, undefined]), 1);
});

test("prueba 19: falta step detector y se redistribuye entre GPS, podometro y acelerometro", () => {
  assert.equal(averageAvailableSignals([1, 0.8, 0.9, null]), 0.9);
});

test("prueba 20: falta rotation vector y otras orientaciones conservan confianza", () => {
  assert.ok(
    Math.abs(averageAvailableSignals([0.8, null, 0.9, 0.7]) - 0.8) <
      0.000_001,
  );
});

test("prueba 21: fallan dos sensores y no reservan peso vacio", () => {
  assert.equal(averageAvailableSignals([1, null, undefined, 0.8]), 0.9);
});

test("prueba 22: faltan opcionales pero GPS y Map Matching permiten tracking", () => {
  assert.equal(
    canUseTerritoryTracking({ gpsAvailable: true, mapMatchingAvailable: true }),
    true,
  );
});

test("prueba 23: sin GPS no se permite conquistar", () => {
  assert.equal(
    canUseTerritoryTracking({ gpsAvailable: false, mapMatchingAvailable: true }),
    false,
  );
});

test("prueba 24: sensor fallido queda temporalmente no disponible", () => {
  assert.equal(
    resolveCapabilityStatus({
      requiresNativeModule: true,
      nativeModuleAvailable: true,
      detected: true,
      active: false,
      temporarilyUnavailable: true,
    }),
    "temporarily-unavailable",
  );
  assert.equal(averageAvailableSignals([null, 1, 0.8]), 0.9);
});

test("prueba 25: permiso denegado se diferencia de hardware ausente", () => {
  assert.equal(
    resolveCapabilityStatus({
      requiresNativeModule: false,
      nativeModuleAvailable: true,
      detected: true,
      active: false,
      permissionDenied: true,
    }),
    "permission-denied",
  );
});
