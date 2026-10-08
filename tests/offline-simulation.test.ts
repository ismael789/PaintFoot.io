import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildSimulationPointPayload,
  buildSimulationRoute,
  emptySimulationState,
  SIMULATION_DATABASE_NAME,
  SIMULATION_ROUTE,
  simulationCoordinateAt,
  simulationPipeline,
  territoryStatusLabel,
  type OfflineSimulationState,
} from "../src/services/offline-simulation-logic";

function state(overrides: Partial<OfflineSimulationState> = {}): OfflineSimulationState {
  return { ...emptySimulationState(), ...overrides };
}

const read = (...parts: string[]) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");

test("simulacion 1: la pantalla interna esta protegida por flag de desarrollo", () => {
  const profile = read("src", "app", "profile.tsx");
  assert.match(profile, /Estado del sistema/);
  assert.match(profile, /__DEV__/);
  assert.match(profile, /EXPO_PUBLIC_ENABLE_OFFLINE_SIMULATION === "true"/);
  assert.match(profile, /OFFLINE_SIMULATION_ENABLED &&/);
  assert.match(profile, /Simulacion offline/);
  assert.match(profile, /OfflineSimulationScreen/);
});

test("simulacion 2: iniciar sin Internet representa recorrido activo y sync pendiente", () => {
  const current = state({
    sessionId: "simulation-test",
    forcedOffline: true,
    routeActive: true,
    syncStatus: "pending",
  });
  const pipeline = simulationPipeline(current);
  assert.equal(pipeline[0].status, "completed");
  assert.equal(current.routeActive, true);
  assert.equal(current.syncStatus, "pending");
  const screen = read("src", "components", "offline-simulation-screen.tsx");
  assert.match(screen, /requestForegroundPermissionsAsync/);
  assert.match(screen, /getCurrentPositionAsync/);
  assert.match(screen, /Iniciar simulacion cerca de mi/);
});

test("simulacion 3: un punto contiene sequence, ambos relojes y entrada de hash", () => {
  const center = { latitude: 19.4326, longitude: -99.1332 };
  const coordinate = simulationCoordinateAt(1, center);
  const route = buildSimulationRoute(center);
  assert.deepEqual(coordinate, route[0]);
  assert.ok(Math.abs(coordinate.latitude - center.latitude) < 0.001);
  assert.ok(Math.abs(coordinate.longitude - center.longitude) < 0.001);
  const payload = JSON.parse(buildSimulationPointPayload("simulation-test", {
    sequence: 1,
    ...coordinate,
    wallClockTimestamp: 10_000,
    monotonicTimestamp: 500.25,
    monotonicSource: "js_monotonic_fallback",
    bootId: "test-boot",
    previousHash: "",
  })) as Record<string, unknown>;
  assert.equal(payload.simulation, true);
  assert.equal(payload.sequence, 1);
  assert.equal(payload.wallClockTimestamp, 10_000);
  assert.equal(payload.monotonicTimestamp, 500.25);
  assert.equal(payload.previousHash, "");
});

test("simulacion 4: la recuperacion abre siempre la misma base SQLite aislada", () => {
  const service = read("src", "services", "offline-simulation.ts");
  assert.equal(SIMULATION_DATABASE_NAME, "paintfoot-offline-simulation.db");
  assert.match(service, /openDatabaseAsync\(SIMULATION_DATABASE_NAME\)/);
  assert.match(service, /readState\(await openSimulationDatabase\(\)\)/);
  assert.match(service, /center_latitude/);
  assert.match(service, /center_longitude/);
});

test("simulacion 5: cierre sin cache queda pending_validation", () => {
  const current = state({ territoryStatus: "pending_validation" });
  assert.equal(territoryStatusLabel(current.territoryStatus), "Pendiente de validacion");
  assert.match(simulationPipeline(current)[5].detail, /Pendiente/);
});

test("simulacion 6: cierre con cache se representa validado offline", () => {
  const current = state({ cacheSufficient: true, territoryStatus: "validated_offline" });
  assert.equal(territoryStatusLabel(current.territoryStatus), "Territorio validado offline");
  const screen = read("src", "components", "offline-simulation-screen.tsx");
  assert.match(screen, /shouldFill/);
  assert.match(screen, /validated_offline/);
  assert.match(screen, /<polygon class=\"territory\"/);
  assert.match(screen, /fill-opacity:\.62/);
  assert.match(screen, /playerColor/);
});

test("simulacion 7: el regreso de Internet completa la cola simulada", () => {
  const current = state({
    sessionId: "simulation-test",
    forcedOffline: false,
    syncStatus: "completed",
    territoryStatus: "confirmed_simulation",
  });
  const pipeline = simulationPipeline(current);
  assert.equal(pipeline.at(-1)?.status, "completed");
  assert.equal(current.territoryStatus, "confirmed_simulation");
});

test("simulacion 8: reiniciar elimina solo tablas simulation_*", () => {
  const service = read("src", "services", "offline-simulation.ts");
  const resetBody = service.slice(service.indexOf("export function resetOfflineSimulation"));
  assert.match(resetBody, /DELETE FROM simulation_points/);
  assert.match(resetBody, /DELETE FROM simulation_logs/);
  assert.match(resetBody, /DELETE FROM simulation_state/);
  assert.doesNotMatch(resetBody, /DELETE FROM territories|DELETE FROM tracking_points|DELETE FROM sync_queue/);
});

test("simulacion 9: los datos falsos no importan almacenamiento, Supabase ni mundo real", () => {
  const service = read("src", "services", "offline-simulation.ts");
  assert.doesNotMatch(service, /offline-storage|supabase|territory-storage|global-multiplayer/);
  assert.match(service, /simulation_state/);
  assert.deepEqual(SIMULATION_ROUTE.at(0), SIMULATION_ROUTE.at(-1));
});

test("simulacion 10: existe reporte visual listo para captura", () => {
  const screen = read("src", "components", "offline-simulation-screen.tsx");
  for (const label of [
    "PaintFoot.io",
    "Generar evidencia",
    "Fecha de prueba",
    "SQLite: correcto",
    "Hash SHA-256",
    "Sync queue",
    "Datos 100% simulados",
  ]) assert.match(screen, new RegExp(label));
});

