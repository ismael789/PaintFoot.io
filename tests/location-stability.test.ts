import assert from "node:assert/strict";
import test from "node:test";

import {
  minimumStableGpsDistance,
  shouldAcceptStableGpsUpdate,
} from "../src/services/location-stability";

const start = { latitude: 32.463, longitude: -114.776, timestamp: 1_000 };

function metersNorth(meters: number, timestamp = 2_000) {
  return {
    latitude: start.latitude + meters / 111_320,
    longitude: start.longitude,
    timestamp,
  };
}

test("GPS quieto exige una distancia mayor que el ruido normal", () => {
  const threshold = minimumStableGpsDistance({
    accuracyMeters: 10,
    reportedSpeedMps: 0,
    sensorMoving: false,
    tracking: true,
    baseDistanceMeters: 3,
    maximumSpeedMps: 10,
  });
  assert.ok(threshold >= 12);
  assert.equal(shouldAcceptStableGpsUpdate(start, metersNorth(7), {
    accuracyMeters: 10,
    reportedSpeedMps: 0,
    sensorMoving: false,
    tracking: true,
    baseDistanceMeters: 3,
    maximumSpeedMps: 10,
  }), false);
});

test("una caminata confirmada conserva puntos detallados", () => {
  assert.equal(shouldAcceptStableGpsUpdate(start, metersNorth(4, 3_000), {
    accuracyMeters: 8,
    reportedSpeedMps: 1.2,
    sensorMoving: true,
    tracking: true,
    baseDistanceMeters: 3,
    maximumSpeedMps: 10,
  }), true);
});

test("la ubicación pasiva no mueve el marcador por deriva pequeña", () => {
  assert.equal(shouldAcceptStableGpsUpdate(start, metersNorth(11, 6_000), {
    accuracyMeters: 12,
    reportedSpeedMps: 0.1,
    tracking: false,
    baseDistanceMeters: 3,
    maximumSpeedMps: 10,
  }), false);
});

test("un salto GPS imposible se rechaza aunque supere el filtro de distancia", () => {
  assert.equal(shouldAcceptStableGpsUpdate(start, metersNorth(80, 2_000), {
    accuracyMeters: 5,
    reportedSpeedMps: null,
    tracking: true,
    baseDistanceMeters: 3,
    maximumSpeedMps: 10,
  }), false);
});
