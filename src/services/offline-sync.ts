import NetInfo from "@react-native-community/netinfo";

import {
  buildSyncOperationPayload,
  getPendingSyncOperations,
  markSyncOperationDone,
  markSyncOperationPending,
  markSyncOperationProcessing,
  saveTrustedServerTime,
} from "@/services/offline-storage";
import { supabase } from "@/services/supabase";
import { getOrCreatePlayerProfile } from "@/services/player-profile";
import {
  discardStoredPendingCapture,
  resolveStoredGlobalCapture,
  restoreStoredTerritoriesFromBackup,
} from "@/services/territory-storage";
import type { Territory } from "@/types/game";
import { confirmGlobalTerritoryCapture } from "@/services/global-multiplayer";
import { debugLog } from "@/utils/debug-log";
import { showFeedback } from "@/services/global-feedback";

let synchronizationPromise: Promise<void> | null = null;
let lastRecoveredUserId: string | null = null;
const ONLINE_SYNC_MESSAGE = "Internet disponible · sincronizando";

export type OfflineSyncStatus = "idle" | "offline" | "syncing" | "synced";

export interface OfflineSyncSnapshot {
  status: OfflineSyncStatus;
  message: string | null;
}

let syncSnapshot: OfflineSyncSnapshot = { status: "idle", message: null };
let syncStatusTimer: ReturnType<typeof setTimeout> | null = null;
const syncStatusListeners = new Set<() => void>();

export function getOfflineSyncSnapshot() {
  return syncSnapshot;
}

export function subscribeToOfflineSyncStatus(listener: () => void) {
  syncStatusListeners.add(listener);
  return () => syncStatusListeners.delete(listener);
}

export function publishOfflineSyncStatus(
  status: OfflineSyncStatus,
  message: string | null = null,
) {
  if (syncStatusTimer) {
    clearTimeout(syncStatusTimer);
    syncStatusTimer = null;
  }
  if (syncSnapshot.status !== status || syncSnapshot.message !== message) {
    syncSnapshot = { status, message };
    for (const listener of syncStatusListeners) listener();
  }
  if (message) {
    showFeedback({
      id: status === "offline" || status === "syncing" || message === "Sincronizado"
        ? "network-status"
        : `sync-${message.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      type:
        status === "synced"
          ? message === "Territorio protegido"
            ? "warning"
            : "success"
          : status === "offline" || status === "syncing"
            ? "info"
            : "error",
      message,
      duration: status === "offline" ? 4_000 : undefined,
    });
  }
  if (status === "synced") {
    syncStatusTimer = setTimeout(() => {
      syncStatusTimer = null;
      publishOfflineSyncStatus("idle", null);
    }, 3_500);
  }
}

function isBackupTerritory(value: unknown): value is Territory {
  if (!value || typeof value !== "object") return false;
  const territory = value as Partial<Territory>;
  return typeof territory.id === "string" &&
    typeof territory.signature === "string" &&
    typeof territory.areaM2 === "number" &&
    territory.polygon?.type === "Polygon" &&
    Array.isArray(territory.coordinates);
}

async function recoverRemoteProgress(userId: string) {
  if (!supabase || lastRecoveredUserId === userId) return;
  const { data, error } = await supabase.rpc("get_paintfoot_snapshot");
  if (error || !data || typeof data !== "object") return;
  const snapshot = data as { territories?: unknown[]; serverTime?: number };
  if (Number.isFinite(snapshot.serverTime)) {
    await saveTrustedServerTime(snapshot.serverTime!);
  }
  const profile = await getOrCreatePlayerProfile();
  const territories = (snapshot.territories ?? [])
    .filter(isBackupTerritory)
    .map((territory) => ({ ...territory, playerId: profile.id }));
  await restoreStoredTerritoriesFromBackup(territories);
  lastRecoveredUserId = userId;
}

export async function synchronizePendingOperations() {
  if (synchronizationPromise) return synchronizationPromise;
  synchronizationPromise = (async () => {
    if (!supabase) {
      publishOfflineSyncStatus("idle", null);
      return;
    }
    const network = await NetInfo.fetch().catch(() => null);
    if (
      network?.isConnected === false ||
      network?.isInternetReachable === false
    ) {
      publishOfflineSyncStatus(
        "offline",
        "Sin conexión · guardando recorrido local",
      );
      return;
    }
    publishOfflineSyncStatus("syncing", ONLINE_SYNC_MESSAGE);
    const { data } = await supabase.auth.getSession();
    if (!data.session?.user) {
      debugLog(
        "ROAD",
        "La copia remota queda pendiente hasta que el jugador inicie sesion.",
      );
      publishOfflineSyncStatus("idle", null);
      return;
    }

    const operations = await getPendingSyncOperations();
    let synchronizedTerritory = false;
    for (const operation of operations) {
      const retryDelay = Math.min(5 * 60_000, 2 ** Math.min(operation.attempts, 8) * 1_000);
      if (
        operation.lastAttemptAt !== null &&
        Date.now() - operation.lastAttemptAt < retryDelay
      ) {
        continue;
      }
      await markSyncOperationProcessing(operation.id);
      try {
        const payload = await buildSyncOperationPayload(operation);
        if (
          operation.entityType === "territory" &&
          ["pending_capture", "pending_global_sync"].includes(
            (payload as Partial<Territory>).status ?? "",
          )
        ) {
          const candidate = payload as unknown as Territory;
          const capture = await confirmGlobalTerritoryCapture(
            candidate,
            candidate.captureSessionId ?? null,
          );
          if (capture.reason === "protected") {
            await discardStoredPendingCapture(candidate.id);
            await markSyncOperationDone(operation.id);
            publishOfflineSyncStatus("synced", "Territorio protegido");
            continue;
          }
          if (capture.reason !== "confirmed") {
            throw new Error(
              capture.reason === "protected"
                ? "TERRITORY_PROTECTED"
                : "CAPTURE_PENDING",
            );
          }
          await resolveStoredGlobalCapture(candidate.id, capture.territory);
          await markSyncOperationDone(operation.id);
          synchronizedTerritory = true;
          continue;
        }
        const { data: syncResult, error } = await supabase.rpc("sync_paintfoot_operation", {
          p_operation_id: operation.id,
          p_action: operation.action,
          p_entity_type: operation.entityType,
          p_entity_id: operation.entityId,
          p_payload: payload,
        });
        if (error) throw error;
        const serverTime = (syncResult as { serverTime?: number } | null)?.serverTime;
        if (Number.isFinite(serverTime)) await saveTrustedServerTime(serverTime!);
        await markSyncOperationDone(operation.id);
      } catch (error) {
        await markSyncOperationPending(
          operation.id,
          error instanceof Error ? error.message : "remote_sync_unavailable",
        );
        debugLog(
          "ROAD",
          "La copia remota sigue pendiente y se reintentara con una conexion estable.",
        );
        publishOfflineSyncStatus(
          "idle",
          "No se pudo sincronizar · se reintentará",
        );
        break;
      }
    }
    await recoverRemoteProgress(data.session.user.id);
    if (syncSnapshot.status === "syncing") {
      publishOfflineSyncStatus(
        "synced",
        synchronizedTerritory ? "Territorio sincronizado" : "Sincronizado",
      );
    }
  })().finally(() => {
    synchronizationPromise = null;
  });
  return synchronizationPromise;
}

export function startOfflineSynchronization() {
  void synchronizePendingOperations();
  const unsubscribeNetwork = NetInfo.addEventListener((state) => {
    if (state.isConnected && state.isInternetReachable !== false) {
      publishOfflineSyncStatus("syncing", ONLINE_SYNC_MESSAGE);
      void synchronizePendingOperations();
    } else if (
      state.isConnected === false ||
      state.isInternetReachable === false
    ) {
      publishOfflineSyncStatus(
        "offline",
        "Sin conexión · guardando recorrido local",
      );
    }
  });
  const authSubscription = supabase?.auth.onAuthStateChange((_event, session) => {
    if (session) void synchronizePendingOperations();
  }).data.subscription;

  return () => {
    unsubscribeNetwork();
    authSubscription?.unsubscribe();
  };
}
