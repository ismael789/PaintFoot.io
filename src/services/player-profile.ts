import AsyncStorage from "@react-native-async-storage/async-storage";

import type { PlayerProfile } from "@/types/game";

const PLAYER_STORAGE_KEY = "@paintfoot/player-profile-v1";
export const PLAYER_COLORS = [
  "#208AEF",
  "#E53935",
  "#7C4DFF",
  "#00897B",
  "#FB8C00",
  "#D81B60",
] as const;

export const DEFAULT_PLAYER_PROFILE: PlayerProfile = {
  id: "",
  name: "Jugador 1",
  color: "#208AEF",
};

function createPlayerId() {
  return `player-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

function colorForPlayerId(playerId: string) {
  let hash = 0;
  for (let index = 0; index < playerId.length; index += 1) {
    hash = (hash * 31 + playerId.charCodeAt(index)) >>> 0;
  }
  return PLAYER_COLORS[hash % PLAYER_COLORS.length];
}

function isPlayerProfile(value: unknown): value is PlayerProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<PlayerProfile>;
  return (
    typeof profile.id === "string" &&
    profile.id.length > 0 &&
    typeof profile.name === "string" &&
    profile.name.length > 0 &&
    typeof profile.color === "string" &&
    /^#[0-9a-f]{6}$/i.test(profile.color)
  );
}

export async function getOrCreatePlayerProfile() {
  const value = await AsyncStorage.getItem(PLAYER_STORAGE_KEY);
  if (value) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isPlayerProfile(parsed)) return parsed;
    } catch {
      // Se reemplaza un perfil local corrupto sin afectar los territorios.
    }
  }

  const id = createPlayerId();
  const profile = {
    ...DEFAULT_PLAYER_PROFILE,
    id,
    color: colorForPlayerId(id),
  };
  await AsyncStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(profile));
  return profile;
}

export async function updatePlayerProfile(input: {
  name: string;
  color: string;
}) {
  const current = await getOrCreatePlayerProfile();
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 30);
  if (name.length < 2) {
    throw new Error("El nombre debe tener al menos 2 caracteres.");
  }
  if (!PLAYER_COLORS.includes(input.color as (typeof PLAYER_COLORS)[number])) {
    throw new Error("El color seleccionado no es valido.");
  }

  const updated: PlayerProfile = {
    ...current,
    name,
    color: input.color,
  };
  await AsyncStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(updated));
  return updated;
}
