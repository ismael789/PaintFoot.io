import assert from "node:assert/strict";
import test from "node:test";

import { buildEndpointCandidates } from "../src/services/network-endpoints";

test("genera puertos WebSocket consecutivos desde la URL configurada", () => {
  const candidates = buildEndpointCandidates(
    "ws://192.168.1.50:8082",
    null,
    { scheme: "ws", defaultPort: 8082, scanCount: 3 },
  );

  assert.deepEqual(candidates, [
    "ws://192.168.1.50:8082",
    "ws://192.168.1.50:8083",
    "ws://192.168.1.50:8084",
  ]);
});

test("deduce los puertos Stripe desde el host de Metro", () => {
  const candidates = buildEndpointCandidates(undefined, "10.0.0.5:8081", {
    scheme: "http",
    defaultPort: 4000,
    fallbackPath: "/api/stripe",
    scanCount: 2,
  });

  assert.deepEqual(candidates, [
    "http://10.0.0.5:4000/api/stripe",
    "http://10.0.0.5:4001/api/stripe",
  ]);
});

test("no altera un endpoint HTTPS sin puerto local explicito", () => {
  const candidates = buildEndpointCandidates(
    "https://pagos.paintfoot.example/api/stripe",
    "10.0.0.5:8081",
    { scheme: "http", defaultPort: 4000 },
  );

  assert.deepEqual(candidates, [
    "https://pagos.paintfoot.example/api/stripe",
  ]);
});
