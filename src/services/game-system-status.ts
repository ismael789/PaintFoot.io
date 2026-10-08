import type { ThemePreference } from "@/types/game";

export type BackgroundTrackingStatus =
  | "expo-go"
  | "inactive"
  | "requesting"
  | "active"
  | "denied"
  | "unavailable";

export type PushStatus =
  | "registering"
  | "registered"
  | "expo-go-unsupported"
  | "physical-device-required"
  | "permission-denied"
  | "missing-project-id"
  | "registration-error";

export type RoadMatchStatus = "idle" | "waiting" | "matching" | "ready" | "pending";
export type GlobalWorldStatus = "offline" | "local" | "connecting" | "active";

export interface GameSystemStatus {
  backgroundTracking: BackgroundTrackingStatus;
  push: PushStatus;
  world: GlobalWorldStatus;
  roads: RoadMatchStatus;
  roadsUsingCache: boolean;
  gpsAccuracy: number | null;
  gpsAvailable: boolean;
  sensorsAvailable: number;
  sensorsActive: number;
  sensorsTotal: number;
  online: boolean;
  pendingValidation: boolean;
}

type GameSystemActions = {
  selectTheme?: (preference: ThemePreference) => void;
  retryRoadMatching?: () => void;
  openNotificationSettings?: () => void;
};

const listeners = new Set<() => void>();
let snapshot: GameSystemStatus = {
  backgroundTracking: "inactive",
  push: "registering",
  world: "local",
  roads: "idle",
  roadsUsingCache: false,
  gpsAccuracy: null,
  gpsAvailable: false,
  sensorsAvailable: 0,
  sensorsActive: 0,
  sensorsTotal: 18,
  online: true,
  pendingValidation: false,
};
let actions: GameSystemActions = {};

export function getGameSystemStatus() {
  return snapshot;
}

export function subscribeToGameSystemStatus(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishGameSystemStatus(patch: Partial<GameSystemStatus>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

export function registerGameSystemActions(nextActions: GameSystemActions) {
  actions = nextActions;
  return () => {
    if (actions === nextActions) actions = {};
  };
}

export function selectGameTheme(preference: ThemePreference) {
  actions.selectTheme?.(preference);
}

export function retryRoadMatching() {
  actions.retryRoadMatching?.();
}

export function openGameNotificationSettings() {
  actions.openNotificationSettings?.();
}

export function backgroundStatusText(status: BackgroundTrackingStatus) {
  return {
    "expo-go": "Disponible solo en APK",
    inactive: "Listo para iniciar",
    requesting: "Esperando permiso",
    active: "Activo",
    denied: "Permiso denegado",
    unavailable: "No disponible en este dispositivo",
  }[status];
}

export function pushStatusText(status: PushStatus) {
  return {
    registering: "Preparando",
    registered: "Activas",
    "expo-go-unsupported": "Disponibles solo en APK",
    "physical-device-required": "Requieren un telefono fisico",
    "permission-denied": "Permiso denegado",
    "missing-project-id": "Pendientes de configurar",
    "registration-error": "No disponibles por ahora",
  }[status];
}

export function roadStatusText(status: RoadMatchStatus) {
  return {
    idle: "Listas para iniciar",
    waiting: "Esperando recorrido",
    matching: "Ajustando recorrido",
    ready: "Recorrido ajustado",
    pending: "Pendientes de validar",
  }[status];
}

export function worldStatusText(status: GlobalWorldStatus, online: boolean) {
  if (!online) return "Guardado sin conexion";
  if (status === "active") return "Global activo";
  if (status === "connecting") return "Sincronizando";
  return "Local";
}
