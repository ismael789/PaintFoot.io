import assert from "node:assert/strict";
import test from "node:test";

import {
  detectProvisionalOfflineCandidate,
  hasSuspiciousClockChange,
} from "../src/services/offline-validation";
import type { RawTrackPoint } from "../src/types/game";

function point(latitude: number, longitude: number, timestamp: number): RawTrackPoint {
  return { latitude, longitude, timestamp, accuracy: 5, speed: 1, heading: 0 };
}

test("offline: un recorrido abierto no crea candidato provisional", () => {
  const track = [
    point(29, -110, 1_000),
    point(29, -109.999, 2_000),
    point(29.001, -109.999, 3_000),
  ];
  assert.equal(detectProvisionalOfflineCandidate(track), null);
});

test("offline: un perimetro geometrico cerrado queda pendiente de validacion vial", () => {
  const track = [
    point(29, -110, 1_000),
    point(29, -109.999, 2_000),
    point(29.001, -109.999, 3_000),
    point(29.001, -110, 4_000),
    point(29, -110, 5_000),
  ];
  const candidate = detectProvisionalOfflineCandidate(track);
  assert.ok(candidate);
  assert.equal(candidate.polygon.type, "Polygon");
  assert.ok(candidate.areaM2 >= 200);
  assert.ok(candidate.perimeterM >= 70);
});

test("offline: el tiempo monotonico detecta un cambio manual del reloj", () => {
  assert.equal(hasSuspiciousClockChange(10_000, 11_000, 500, 1_500), false);
  assert.equal(hasSuspiciousClockChange(10_000, 5_000, 500, 1_500), true);
});
