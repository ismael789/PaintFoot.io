import type { RealtimeChannel, Session } from "@supabase/supabase-js";

import { GLOBAL_MULTIPLAYER_RULES } from "@/config/territory";
import type { MultiplayerPreferences } from "@/services/multiplayer-preferences";
import {
  coordinateRegionId,
  neighboringRoadRegionIds,
} from "@/services/offline-storage";
import {
  applyGlobalPlayerProfile,
} from "@/services/player-profile";
import { supabase } from "@/services/supabase";
import type {
  GeoCoordinate,
  NearbyPlayer,
  PlayerProfile,
  Territory,
  TerritoryStatus,
} from "@/types/game";
import { normalizeNearbyPlayers } from "@/services/global-multiplayer-logic";
import type { GlobalWorldStatus } from "@/services/game-system-status";

export type { GlobalWorldStatus } from "@/services/game-system-status";

interface GlobalProfileRow {
  id: string;
  username: string;
  global_color: string;
}

interface GlobalTerritoryRow {
  id: string;
  owner_id: string;
  owner_name: string;
  owner_color: string;
  status: TerritoryStatus;
  payload: Record<string, unknown>;
  region_ids: string[];
  shield_expires_at: string | null;
}

interface VerifiedPresenceRow {
  id: string;
  name: string;
  color: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  heading: number | null;
  speed: number | null;
  region_id: string;
  updated_at_ms: number;
  trail: GeoCoordinate[] | null;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function territoryFromRow(row: GlobalTerritoryRow): Territory | null {
  const payload = row.payload as Partial<Territory>;
  if (
    typeof row.id !== "string" ||
    !payload.polygon ||
    payload.polygon.type !== "Polygon" ||
    !Array.isArray(payload.coordinates) ||
    typeof payload.areaM2 !== "number" ||
    typeof payload.signature !== "string"
  ) {
    return null;
  }
  const playerColor = isHexColor(row.owner_color)
    ? row.owner_color
    : isHexColor(payload.playerColor)
      ? payload.playerColor
      : "#208AEF";
  return {
    ...payload,
    id: row.id,
    playerId: row.owner_id,
    globalOwnerId: row.owner_id,
    owner: row.owner_name || payload.owner || "Jugador",
    playerColor,
    color: playerColor,
    status: row.status,
    regionIds: row.region_ids,
    shield: payload.shield ?? null,
  } as Territory;
}

async function currentSession(): Promise<Session | null> {
  if (!supabase) return null;
  return (await supabase.auth.getSession()).data.session;
}

export async function synchronizeGlobalPlayerProfile(local: PlayerProfile) {
  if (!supabase) return local;
  const session = await currentSession();
  if (!session) return local;
  const { data, error } = await supabase.rpc("ensure_paintfoot_profile", {
    p_username: local.name,
  });
  if (error || !data) return local;
  const row = (Array.isArray(data) ? data[0] : data) as GlobalProfileRow;
  if (!row?.id || !isHexColor(row.global_color)) return local;
  return applyGlobalPlayerProfile({
    id: row.id,
    name: row.username || local.name,
    color: row.global_color,
  });
}

export async function loadGlobalTerritoriesForRegions(
  regionIds: string[],
  preferences: MultiplayerPreferences,
) {
  if (!supabase || regionIds.length === 0) return [];
  const session = await currentSession();
  if (!session) return [];
  const territories: Territory[] = [];
  for (
    let page = 0;
    page < GLOBAL_MULTIPLAYER_RULES.maximumTerritoryPages;
    page += 1
  ) {
    const { data, error } = await supabase.rpc("get_global_territories", {
      p_region_ids: regionIds,
      p_limit: GLOBAL_MULTIPLAYER_RULES.territoryPageSize,
      p_offset: page * GLOBAL_MULTIPLAYER_RULES.territoryPageSize,
    });
    if (error || !Array.isArray(data)) break;
    const pageTerritories = (data as GlobalTerritoryRow[])
      .map(territoryFromRow)
      .filter((territory): territory is Territory => territory !== null)
      .filter((territory) => {
        if (!preferences.showProtectedTerritories && territory.status === "protected") return false;
        if (!preferences.showDisputedTerritories && territory.status === "disputed") return false;
        return territory.status !== "rejected";
      });
    territories.push(...pageTerritories);
    if (data.length < GLOBAL_MULTIPLAYER_RULES.territoryPageSize) break;
  }
  return territories;
}

export async function confirmGlobalTerritoryCapture(
  candidate: Territory,
  captureSessionId: string | null,
) {
  if (!supabase) return { territory: { ...candidate, status: "pending_capture" as const }, reason: "offline" };
  const session = await currentSession();
  if (!session) return { territory: { ...candidate, status: "pending_capture" as const }, reason: "login_required" };
  const { data, error } = await supabase.rpc("confirm_territory_capture", {
    p_operation_id: `capture:${candidate.id}`,
    p_candidate_id: candidate.id,
    p_target_territory_id: candidate.targetTerritoryId ?? null,
    p_capture_session_id: captureSessionId,
    p_candidate: candidate,
  });
  if (error || !data) {
    const protectedTerritory = error?.message?.includes("TERRITORY_PROTECTED");
    return {
      territory: {
        ...candidate,
        status: protectedTerritory ? "rejected" as const : "pending_capture" as const,
      },
      reason: protectedTerritory ? "protected" : "retry",
    };
  }
  const result = data as { territory?: GlobalTerritoryRow; status?: TerritoryStatus };
  const territory = result.territory ? territoryFromRow(result.territory) : null;
  return {
    territory: territory ?? { ...candidate, status: result.status ?? "confirmed" },
    reason: "confirmed",
  };
}

export async function synchronizeGlobalTerritoryShield(territory: Territory) {
  if (!supabase || !territory.globalOwnerId) return;
  await supabase.rpc("set_owned_territory_shield", {
    p_territory_id: territory.id,
    p_expires_at_ms: territory.shield?.expiresAt ?? null,
    p_duration_hours: territory.shield?.durationHours ?? null,
  });
}

type ControllerCallbacks = {
  onTerritories: (territories: Territory[]) => void;
  onNearbyPlayers: (players: NearbyPlayer[]) => void;
  onStatus: (status: GlobalWorldStatus) => void;
};

export class GlobalMultiplayerController {
  private channels = new Map<string, RealtimeChannel>();
  private centerRegionId: string | null = null;
  private currentRegionIds: string[] = [];
  private lastPublishedAt = 0;
  private lastPresencePersistedAt = 0;
  private sharingPresence = false;
  private lastTerritoryLoadAt = 0;
  private latestCoordinate: GeoCoordinate | null = null;
  private latestTrail: GeoCoordinate[] = [];
  private profile: PlayerProfile | null = null;
  private preferences: MultiplayerPreferences | null = null;
  private callbacks: ControllerCallbacks;

  constructor(callbacks: ControllerCallbacks) {
    this.callbacks = callbacks;
  }

  async update(
    coordinate: GeoCoordinate,
    profile: PlayerProfile,
    preferences: MultiplayerPreferences,
    activeTrail: GeoCoordinate[] = [],
  ) {
    this.latestCoordinate = coordinate;
    const stride = Math.max(1, Math.ceil(activeTrail.length / 24));
    this.latestTrail = activeTrail
      .filter((_point, index) => index % stride === 0 || index === activeTrail.length - 1)
      .slice(-24)
      .map(({ latitude, longitude }) => ({ latitude, longitude }));
    this.profile = profile;
    this.preferences = preferences;
    if (!supabase || !profile.globalId) {
      this.callbacks.onStatus("local");
      return;
    }
    const regionId = coordinateRegionId(coordinate);
    if (regionId !== this.centerRegionId) {
      this.callbacks.onStatus("connecting");
      await this.subscribeToRegions(coordinate);
      await this.refreshTerritories(true);
    } else {
      await this.refreshTerritories(false);
    }
    await this.publishPresence();
  }

  private async subscribeToRegions(coordinate: GeoCoordinate) {
    await this.removeChannels();
    this.centerRegionId = coordinateRegionId(coordinate);
    this.currentRegionIds = neighboringRoadRegionIds(
      coordinate,
      GLOBAL_MULTIPLAYER_RULES.regionSubscriptionRadius,
    ).slice(0, GLOBAL_MULTIPLAYER_RULES.maximumActiveRegionalChannels);

    for (const regionId of this.currentRegionIds) {
      const channel = supabase!.channel(`paintfoot-world:${regionId}`, {
        config: { presence: { key: this.profile!.globalId! } },
      });
      channel
        .on("presence", { event: "sync" }, () => void this.emitPresence())
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "territories",
            filter: `primary_region=eq.${regionId}`,
          },
          () => void this.refreshTerritories(true),
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            this.callbacks.onStatus("active");
            if (regionId === this.centerRegionId) void this.publishPresence(true);
          }
        });
      this.channels.set(regionId, channel);
    }
  }

  private async refreshTerritories(force: boolean) {
    if (!this.preferences) return;
    if (!force && Date.now() - this.lastTerritoryLoadAt < 20_000) return;
    const territories = await loadGlobalTerritoriesForRegions(
      this.currentRegionIds,
      this.preferences,
    );
    this.lastTerritoryLoadAt = Date.now();
    this.callbacks.onTerritories(territories);
  }

  private async publishPresence(force = false) {
    if (!this.preferences?.shareRealtimeLocation) {
      if (this.sharingPresence && this.centerRegionId) {
        await this.channels.get(this.centerRegionId)?.untrack();
        void supabase!.rpc("clear_player_presence");
        this.sharingPresence = false;
      }
      return;
    }
    if (
      !this.latestCoordinate ||
      !this.profile?.globalId ||
      !this.centerRegionId
    ) return;
    if (
      !force &&
      Date.now() - this.lastPublishedAt <
        GLOBAL_MULTIPLAYER_RULES.presencePublishIntervalMs
    ) return;
    const channel = this.channels.get(this.centerRegionId);
    if (!channel) return;
    if (
      Date.now() - this.lastPresencePersistedAt >=
      GLOBAL_MULTIPLAYER_RULES.presencePersistenceIntervalMs
    ) {
      this.lastPresencePersistedAt = Date.now();
      await supabase!.rpc("publish_player_presence", {
        p_region_id: this.centerRegionId,
        p_latitude: this.latestCoordinate.latitude,
        p_longitude: this.latestCoordinate.longitude,
        p_accuracy: null,
        p_heading: null,
        p_speed: null,
        p_state: "playing",
        p_trail: this.latestTrail,
      });
    }
    // El canal solo avisa que hay datos nuevos. Identidad, color y posicion
    // se vuelven a leer desde la RPC protegida por auth.uid().
    await channel.track({ updatedAt: Date.now() });
    this.sharingPresence = true;
    this.lastPublishedAt = Date.now();
  }

  private async emitPresence() {
    if (!this.preferences?.showNearbyPlayers || !this.profile?.globalId) {
      this.callbacks.onNearbyPlayers([]);
      return;
    }
    const { data, error } = await supabase!.rpc("get_nearby_player_presence", {
      p_region_ids: this.currentRegionIds,
    });
    if (error || !Array.isArray(data)) return;
    const nearbyEntries = (data as VerifiedPresenceRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracy: row.accuracy,
      heading: row.heading,
      speed: row.speed,
      regionId: row.region_id,
      updatedAt: row.updated_at_ms,
      trail: Array.isArray(row.trail) ? row.trail : [],
    }));
    this.callbacks.onNearbyPlayers(
      normalizeNearbyPlayers(nearbyEntries, this.profile.globalId),
    );
  }

  private async removeChannels() {
    const channels = [...this.channels.values()];
    this.channels.clear();
    await Promise.all(channels.map((channel) => supabase!.removeChannel(channel)));
  }

  async stop() {
    if (this.sharingPresence && supabase) void supabase.rpc("clear_player_presence");
    await this.removeChannels();
    this.callbacks.onNearbyPlayers([]);
    this.callbacks.onStatus("offline");
  }
}

