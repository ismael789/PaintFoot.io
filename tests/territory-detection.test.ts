import assert from "node:assert/strict";
import test from "node:test";

import {
  createTerritoryFromLoop,
  detectClosedLoops,
} from "../src/services/territory-detection";
import type {
  GeoCoordinate,
  RawTrackPoint,
  RoadSegment,
} from "../src/types/game";
import { polygonAreaM2 } from "../src/utils/geo";

const ORIGIN = { latitude: 29.0729, longitude: -110.9559 };

function point(eastMeters: number, northMeters: number): GeoCoordinate {
  const latitude = ORIGIN.latitude + northMeters / 111_320;
  const longitude =
    ORIGIN.longitude +
    eastMeters / (111_320 * Math.cos((ORIGIN.latitude * Math.PI) / 180));
  return { latitude, longitude };
}

function roadSegment(
  id: string,
  start: GeoCoordinate,
  end: GeoCoordinate,
): RoadSegment {
  return {
    id,
    wayId: id,
    name: null,
    coordinates: [start, end],
    startNodeId: `${start.latitude}:${start.longitude}`,
    endNodeId: `${end.latitude}:${end.longitude}`,
    intersectingEdgeCount: 0,
    endNodeType: null,
  };
}

function rawPoint(
  eastMeters: number,
  northMeters: number,
  accuracy: number,
): RawTrackPoint {
  return { ...point(eastMeters, northMeters), accuracy };
}

test("recorrido abierto no crea territorio", () => {
  const track = [point(0, 0), point(35, 0), point(35, 35), point(10, 35)];
  assert.equal(detectClosedLoops(track).length, 0);
});

test("rectangulo vial cerrado crea un territorio con area", () => {
  const track = [
    point(0, 0),
    point(35, 0),
    point(35, 30),
    point(0, 30),
    point(0, 0),
  ];
  const loops = detectClosedLoops(track);
  assert.equal(loops.length, 1);
  assert.ok(loops[0].areaM2 > 1_000 && loops[0].areaM2 < 1_100);
});

test("poligono irregular cerrado es valido", () => {
  const track = [
    point(0, 0),
    point(35, 0),
    point(48, 22),
    point(25, 45),
    point(-10, 25),
    point(0, 0),
  ];
  const loops = detectClosedLoops(track);
  assert.equal(loops.length, 1);
  assert.ok(loops[0].areaM2 > 1_000);
});

test("circuito triangular de calles tambien es valido", () => {
  const track = [
    point(0, 0),
    point(45, 0),
    point(20, 40),
    point(0, 0),
  ];
  const loops = detectClosedLoops(track);
  assert.equal(loops.length, 1);
  assert.ok(loops[0].areaM2 > 800);
});

test("pasar cerca sin entrar en tolerancia no cierra", () => {
  const track = [
    point(0, 0),
    point(35, 0),
    point(35, 35),
    point(0, 35),
    point(0, 22),
  ];
  assert.equal(detectClosedLoops(track).length, 0);
});

test("la tolerancia por si sola no cierra el circuito", () => {
  const track = [
    point(0, 0),
    point(35, 0),
    point(35, 35),
    point(0, 35),
    point(0, 4),
  ];
  assert.equal(detectClosedLoops(track).length, 0);
});

test("prueba A: territorio cerrado de aproximadamente 300 m2 es valido", () => {
  const track = [
    point(0, 0),
    point(25, 0),
    point(25, 12),
    point(0, 12),
    point(0, 0),
  ];
  const loops = detectClosedLoops(track);
  assert.equal(loops.length, 1);
  assert.ok(loops[0].areaM2 > 290 && loops[0].areaM2 < 310);
});

test("prueba B: territorio cerrado de aproximadamente 300000 m2 es valido", () => {
  const track = [
    point(0, 0),
    point(600, 0),
    point(600, 500),
    point(0, 500),
    point(0, 0),
  ];
  const loops = detectClosedLoops(track);
  assert.equal(loops.length, 1);
  assert.ok(loops[0].areaM2 > 295_000 && loops[0].areaM2 < 305_000);
});

test("prueba C: pasar a 10 m del recorrido anterior con circuito abierto no conquista", () => {
  const track = [
    point(0, 0),
    point(100, 0),
    point(100, 100),
    point(0, 100),
    point(0, 10),
  ];
  assert.equal(detectClosedLoops(track).length, 0);
});

test("prueba D: GPS a 10 m cierra cuando los segmentos prueban el circuito completo", () => {
  const a = point(0, 0);
  const b = point(100, 0);
  const c = point(100, 100);
  const d = point(0, 100);
  const reportedEnd = point(0, 10);
  const track = [a, b, c, d, reportedEnd];
  const currentSessionSegments = [
    roadSegment("ab", a, b),
    roadSegment("bc", b, c),
    roadSegment("cd", c, d),
    roadSegment("da", d, a),
  ];
  const loops = detectClosedLoops(track, 1, undefined, {
    currentSessionSegments,
  });
  assert.equal(loops.length, 1);
});

test("prueba E: cercania menor a 15 m sin el lado faltante no conquista", () => {
  const a = point(0, 0);
  const b = point(100, 0);
  const c = point(100, 100);
  const d = point(0, 100);
  const reportedEnd = point(0, 10);
  const track = [a, b, c, d, reportedEnd];
  const incompleteSessionSegments = [
    roadSegment("ab", a, b),
    roadSegment("bc", b, c),
    roadSegment("cd", c, d),
    roadSegment("d-end", d, reportedEnd),
  ];
  assert.equal(
    detectClosedLoops(track, 1, undefined, {
      currentSessionSegments: incompleteSessionSegments,
      rawTrack: [
        rawPoint(0, 0, 2),
        rawPoint(100, 0, 2),
        rawPoint(100, 100, 2),
        rawPoint(0, 100, 2),
        rawPoint(0, 10, 2),
      ],
    }).length,
    0,
  );
});

test("prueba F: perimetro grande con cientos de puntos cierra completo", () => {
  const track: GeoCoordinate[] = [];
  const pointsPerSide = 100;
  for (let index = 0; index < pointsPerSide; index += 1) {
    track.push(point(index * 6, 0));
  }
  for (let index = 0; index < pointsPerSide; index += 1) {
    track.push(point(600, index * 5));
  }
  for (let index = 0; index < pointsPerSide; index += 1) {
    track.push(point(600 - index * 6, 500));
  }
  for (let index = 0; index < pointsPerSide; index += 1) {
    track.push(point(0, 500 - index * 5));
  }
  track.push(point(0, 0));

  const loops = detectClosedLoops(track);
  assert.equal(loops.length, 1);
  assert.ok(loops[0].areaM2 > 295_000);
});

test("prueba K: los sensores no crean territorio sin perimetro completo", () => {
  const timestamp = Date.now();
  const openTrack = [
    point(0, 0),
    point(100, 0),
    point(100, 100),
    point(10, 100),
  ].map<RawTrackPoint>((coordinate) => ({
    ...coordinate,
    accuracy: 5,
    speed: 1.5,
    sensor: {
      timestamp,
      availability: {
        accelerometer: true,
        compass: true,
        deviceMotion: true,
        gyroscope: true,
        magnetometer: true,
      },
      compassAccuracy: 3,
      compassHeadingDegrees: 270,
      gyroscopeRotationRateRadS: 2,
      deviceMotionRotationRateDegS: 90,
      accelerationDeltaG: 0.2,
      magneticFieldMicrotesla: 45,
      moving: true,
    },
  }));

  assert.equal(detectClosedLoops(openTrack).length, 0);
});

test("ruido GPS pequeno no crea territorio falso", () => {
  const track = [
    point(0, 0),
    point(4, 0),
    point(4, 4),
    point(0, 4),
    point(0, 0),
  ];
  assert.equal(detectClosedLoops(track).length, 0);
});

test("autocruce en forma de ocho produce dos circuitos validos", () => {
  const track = [
    point(0, 0),
    point(25, 20),
    point(0, 40),
    point(-25, 20),
    point(0, 0),
    point(25, -20),
    point(0, -40),
    point(-25, -20),
    point(0, 0),
  ];
  const loops = detectClosedLoops(track);
  assert.equal(loops.length, 2);
  assert.ok(loops.every((loop) => polygonAreaM2(loop.coordinates) > 900));
});

test("cada territorio conserva el color real de su jugador", () => {
  const loop = detectClosedLoops([
    point(0, 0),
    point(35, 0),
    point(35, 30),
    point(0, 30),
    point(0, 0),
  ])[0];
  const blue = createTerritoryFromLoop(loop, {
    id: "blue-player",
    name: "Azul",
    color: "#208AEF",
  });
  const red = createTerritoryFromLoop(loop, {
    id: "red-player",
    name: "Rojo",
    color: "#FF4444",
  });

  assert.equal(blue.playerColor, "#208AEF");
  assert.equal(blue.color, "#208AEF");
  assert.equal(red.playerColor, "#FF4444");
  assert.equal(red.color, "#FF4444");
});
