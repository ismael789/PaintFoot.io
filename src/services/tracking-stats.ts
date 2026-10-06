import AsyncStorage from "@react-native-async-storage/async-storage";

import type {
  ThemePreference,
  TrackingSessionSummary,
} from "../types/game";

const SESSION_HISTORY_KEY = "@paintfoot/tracking-sessions-v1";
const DAILY_STEPS_KEY = "@paintfoot/daily-steps-v1";
const THEME_PREFERENCE_KEY = "@paintfoot/theme-preference-v1";
const MAX_SESSION_HISTORY = 100;

function localDayKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function mergeDailySteps(
  current: Record<string, number>,
  steps: number,
  timestamp = Date.now(),
) {
  const day = localDayKey(timestamp);
  return {
    ...current,
    [day]: Math.max(0, current[day] ?? 0) + Math.max(0, Math.round(steps)),
  };
}

export async function saveTrackingSession(summary: TrackingSessionSummary) {
  const storedDailySteps = await AsyncStorage.getItem(DAILY_STEPS_KEY);
  const dailySteps = storedDailySteps
    ? (JSON.parse(storedDailySteps) as Record<string, number>)
    : {};
  const nextDailySteps = mergeDailySteps(
    dailySteps,
    summary.steps ?? 0,
    summary.endedAt,
  );
  await AsyncStorage.setItem(DAILY_STEPS_KEY, JSON.stringify(nextDailySteps));
  const completedSummary = {
    ...summary,
    dailySteps: Math.max(
      summary.dailySteps,
      nextDailySteps[localDayKey(summary.endedAt)],
    ),
  };

  const storedSessions = await AsyncStorage.getItem(SESSION_HISTORY_KEY);
  const sessions = storedSessions
    ? (JSON.parse(storedSessions) as TrackingSessionSummary[])
    : [];
  await AsyncStorage.setItem(
    SESSION_HISTORY_KEY,
    JSON.stringify(
      [...sessions, completedSummary].slice(-MAX_SESSION_HISTORY),
    ),
  );
  return completedSummary;
}

export async function getLatestTrackingSession() {
  const stored = await AsyncStorage.getItem(SESSION_HISTORY_KEY);
  if (!stored) return null;
  const sessions = JSON.parse(stored) as TrackingSessionSummary[];
  return sessions.at(-1) ?? null;
}

export async function getThemePreference(): Promise<ThemePreference> {
  const value = await AsyncStorage.getItem(THEME_PREFERENCE_KEY);
  return value === "light" || value === "dark" || value === "auto"
    ? value
    : "auto";
}

export function saveThemePreference(preference: ThemePreference) {
  return AsyncStorage.setItem(THEME_PREFERENCE_KEY, preference);
}
