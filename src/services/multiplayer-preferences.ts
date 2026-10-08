import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@paintfoot/global-multiplayer-preferences-v1";

export interface MultiplayerPreferences {
  showNearbyPlayers: boolean;
  shareRealtimeLocation: boolean;
  showPlayerNames: boolean;
  showOtherTerritories: boolean;
  showProtectedTerritories: boolean;
  showDisputedTerritories: boolean;
}

export const DEFAULT_MULTIPLAYER_PREFERENCES: MultiplayerPreferences = {
  showNearbyPlayers: true,
  shareRealtimeLocation: true,
  showPlayerNames: true,
  showOtherTerritories: true,
  showProtectedTerritories: true,
  showDisputedTerritories: true,
};

export async function getMultiplayerPreferences() {
  const stored = await AsyncStorage.getItem(STORAGE_KEY);
  if (!stored) return DEFAULT_MULTIPLAYER_PREFERENCES;
  try {
    return {
      ...DEFAULT_MULTIPLAYER_PREFERENCES,
      ...(JSON.parse(stored) as Partial<MultiplayerPreferences>),
    };
  } catch {
    return DEFAULT_MULTIPLAYER_PREFERENCES;
  }
}

export async function saveMultiplayerPreferences(
  preferences: MultiplayerPreferences,
) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

