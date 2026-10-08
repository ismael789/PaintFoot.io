export const SIMULATION_DATABASE_NAME = "paintfoot-offline-simulation.db";

export type SimulationTerritoryStatus =
  | "none"
  | "pending_validation"
  | "validated_offline"
  | "confirmed_simulation"
  | "rejected_simulation";

export type SimulationSyncStatus =
  | "idle"
  | "pending"
  | "processing"
  | "completed";

export interface SimulationPointDraft {
  sequence: number;
  latitude: number;
  longitude: number;
  wallClockTimestamp: number;
  monotonicTimestamp: number;
  monotonicSource: "android_elapsed_realtime" | "js_monotonic_fallback";
  bootId: string;
  previousHash: string;
}

export interface OfflineSimulationPoint extends SimulationPointDraft {
  sessionId: string;
  currentHash: string;
}

export interface OfflineSimulationLog {
  id: number;
  createdAt: number;
  message: string;
  level: "active" | "completed" | "pending" | "error";
}

export interface OfflineSimulationState {
  sessionId: string | null;
  centerLatitude: number | null;
  centerLongitude: number | null;
  centerAccuracy: number | null;
  forcedOffline: boolean;
  routeActive: boolean;
  cacheSufficient: boolean;
  territoryStatus: SimulationTerritoryStatus;
  syncStatus: SimulationSyncStatus;
  startedAt: number | null;
  updatedAt: number | null;
  points: OfflineSimulationPoint[];
  logs: OfflineSimulationLog[];
}

export interface SimulationPipelineStep {
  label: string;
  detail: string;
  status: "pending" | "active" | "completed" | "error";
}

// Route kept intentionally small and deterministic. It is never submitted to
// the real territory detector, sync queue or global world.
export const SIMULATION_ROUTE = [
  { latitude: 29.07272, longitude: -110.95618 },
  { latitude: 29.07272, longitude: -110.95592 },
  { latitude: 29.07272, longitude: -110.95566 },
  { latitude: 29.07294, longitude: -110.95566 },
  { latitude: 29.07316, longitude: -110.95566 },
  { latitude: 29.07316, longitude: -110.95592 },
  { latitude: 29.07316, longitude: -110.95618 },
  { latitude: 29.07294, longitude: -110.95618 },
  { latitude: 29.07272, longitude: -110.95618 },
] as const;

export interface SimulationCenter {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

const DEFAULT_SIMULATION_CENTER: SimulationCenter = {
  latitude: 29.07294,
  longitude: -110.95592,
  accuracy: null,
};

export function buildSimulationRoute(center?: SimulationCenter | null) {
  const origin = center ?? DEFAULT_SIMULATION_CENTER;
  const latitudeScale = 1 / 111_320;
  const longitudeScale =
    1 / (111_320 * Math.max(0.2, Math.cos((origin.latitude * Math.PI) / 180)));
  const offsetsMeters = [
    [-24, -25],
    [-24, 0],
    [-24, 25],
    [0, 25],
    [24, 25],
    [24, 0],
    [24, -25],
    [0, -25],
    [-24, -25],
  ] as const;
  return offsetsMeters.map(([north, east]) => ({
    latitude: origin.latitude + north * latitudeScale,
    longitude: origin.longitude + east * longitudeScale,
  }));
}

export function emptySimulationState(): OfflineSimulationState {
  return {
    sessionId: null,
    centerLatitude: null,
    centerLongitude: null,
    centerAccuracy: null,
    forcedOffline: false,
    routeActive: false,
    cacheSufficient: false,
    territoryStatus: "none",
    syncStatus: "idle",
    startedAt: null,
    updatedAt: null,
    points: [],
    logs: [],
  };
}

export function simulationCoordinateAt(
  sequence: number,
  center?: SimulationCenter | null,
) {
  const route = buildSimulationRoute(center);
  const index = Math.max(0, sequence - 1) % route.length;
  return route[index];
}

export function buildSimulationPointPayload(
  sessionId: string,
  point: SimulationPointDraft,
) {
  return JSON.stringify({
    simulation: true,
    sessionId,
    sequence: point.sequence,
    latitude: Number(point.latitude.toFixed(7)),
    longitude: Number(point.longitude.toFixed(7)),
    wallClockTimestamp: point.wallClockTimestamp,
    monotonicTimestamp: Number(point.monotonicTimestamp.toFixed(3)),
    monotonicSource: point.monotonicSource,
    bootId: point.bootId,
    previousHash: point.previousHash,
  });
}

export function territoryStatusLabel(status: SimulationTerritoryStatus) {
  switch (status) {
    case "pending_validation":
      return "Pendiente de validacion";
    case "validated_offline":
      return "Territorio validado offline";
    case "confirmed_simulation":
      return "Territorio confirmado (simulacion)";
    case "rejected_simulation":
      return "Territorio rechazado (simulacion)";
    default:
      return "Esperando cierre del perimetro";
  }
}

export function simulationPipeline(
  state: OfflineSimulationState,
): SimulationPipelineStep[] {
  const hasPoints = state.points.length > 0;
  const hasTerritoryCandidate = state.territoryStatus !== "none";
  const syncCompleted = state.syncStatus === "completed";
  return [
    {
      label: "SIN INTERNET",
      detail: state.forcedOffline ? "Forzado solo dentro de esta prueba" : "Esperando inicio",
      status: state.forcedOffline ? "completed" : state.sessionId ? "completed" : "pending",
    },
    {
      label: "GPS guardado",
      detail: `${state.points.length} punto${state.points.length === 1 ? "" : "s"}`,
      status: hasPoints ? "completed" : state.routeActive ? "active" : "pending",
    },
    {
      label: "SQLite",
      detail: hasPoints ? "Persistencia local correcta" : "Base aislada lista",
      status: state.sessionId ? "completed" : "pending",
    },
    {
      label: "Reloj interno",
      detail: state.points.at(-1)?.monotonicSource ?? "Esperando punto",
      status: hasPoints ? "completed" : "pending",
    },
    {
      label: "Hash SHA-256",
      detail: hasPoints ? "Cadena de integridad actualizada" : "Esperando punto",
      status: hasPoints ? "completed" : "pending",
    },
    {
      label: "Validacion",
      detail: territoryStatusLabel(state.territoryStatus),
      status: hasTerritoryCandidate ? "completed" : "pending",
    },
    {
      label: "Vuelve Internet",
      detail: state.forcedOffline ? "Esperando Internet simulado" : state.sessionId ? "Disponible" : "Esperando inicio",
      status: state.forcedOffline ? "pending" : state.sessionId ? "completed" : "pending",
    },
    {
      label: "Sincronizacion",
      detail:
        state.syncStatus === "processing"
          ? "Procesando cola simulada"
          : state.syncStatus === "completed"
            ? "Completada"
            : "Pendiente",
      status: syncCompleted
        ? "completed"
        : state.syncStatus === "processing"
          ? "active"
          : "pending",
    },
  ];
}

