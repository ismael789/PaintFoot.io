import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRoadGraph,
  decodeValhallaPolyline,
  getRoadMatchingWindow,
  matchTraceToRoads,
} from "../src/services/road-matching";

const REAL_VALHALLA_SHAPE =
  "yow`d@h|uc|D?p@IlAc@lAsGtEu@`@g@sD]{E@aEJoDJw@ZaChBuIz@_GIgCUuA]aAoJsXeAyCy@{Beb@giAm@gBgA^_PjG";

test("decodifica la geometria polyline6 devuelta por Valhalla", () => {
  const coordinates = decodeValhallaPolyline(REAL_VALHALLA_SHAPE);
  assert.equal(coordinates.length, 24);
  assert.ok(coordinates[0].latitude > 19 && coordinates[0].latitude < 20);
  assert.ok(coordinates[0].longitude < -99 && coordinates[0].longitude > -100);
});

test("convierte la respuesta vial en segmentos y nodos", async () => {
  const responsePayload = {
    shape: REAL_VALHALLA_SHAPE,
    edges: [
      {
        way_id: 1240311903,
        id: 7256721382170,
        begin_shape_index: 0,
        end_shape_index: 4,
        end_node: {
          type: "street_intersection",
          intersecting_edges: [{ walkability: "both" }],
        },
      },
      {
        way_id: 616977443,
        id: 8986648956097,
        begin_shape_index: 4,
        end_shape_index: 10,
        names: ["Avenida Paseo de la Reforma"],
      },
    ],
    matched_points: [
      { lat: 19.427597, lon: -99.167701, type: "matched", edge_index: 0 },
      { lat: 19.428053, lon: -99.166321, type: "matched", edge_index: 1 },
    ],
  };
  const fakeFetch = async () =>
    new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const result = await matchTraceToRoads(
    [
      {
        latitude: 19.4275,
        longitude: -99.1677,
        accuracy: 8,
        timestamp: 1,
      },
      {
        latitude: 19.4282,
        longitude: -99.1664,
        accuracy: 8,
        timestamp: 2,
      },
    ],
    { fetchImplementation: fakeFetch as typeof fetch },
  );

  assert.equal(result.unmatchedPointCount, 0);
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[1].name, "Avenida Paseo de la Reforma");
  assert.equal(result.snappedTrack[0].roadWayId, "1240311903");
  const graph = buildRoadGraph(result.segments);
  assert.equal(graph.segments.length, 2);
  assert.ok(graph.nodes.length >= 2);
  assert.equal(graph.intersectionCount, 1);
});

test("recuperacion offline procesa cientos de puntos por lotes sin saltarlos", () => {
  const first = getRoadMatchingWindow(500, 0);
  assert.deepEqual(first, { start: 0, end: 120 });

  const second = getRoadMatchingWindow(500, first.end);
  assert.deepEqual(second, { start: 112, end: 232 });

  const final = getRoadMatchingWindow(500, 488);
  assert.deepEqual(final, { start: 480, end: 500 });
});
