import { Palette } from "@/constants/palette";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { AppState, Platform } from "react-native";

import { requestAuthenticatedPaintFootApi } from "@/services/auth";

export const NOTIFICATION_CHANNELS = {
  game: "paintfoot-game",
  shields: "paintfoot-shields",
  sync: "paintfoot-sync",
  coins: "paintfoot-coins",
  territories: "paintfoot-territories",
  payments: "paintfoot-payments",
} as const;
export const GAME_EVENTS_CHANNEL_ID = NOTIFICATION_CHANNELS.game;

export type NotificationCategory = "shields" | "territories" | "coins" | "sync" | "world" | "payments";
export type NotificationPreferences = Record<NotificationCategory, boolean>;
export type NotificationDestination =
  | "paintfoot://shield"
  | "paintfoot://payments"
  | "paintfoot://map"
  | `paintfoot://territory/${string}`
  | "paintfoot://coins"
  | "paintfoot://sync";
export type NotificationRoute = "/" | "/payments" | "/profile" | `/?territoryId=${string}`;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  shields: true,
  territories: true,
  coins: true,
  sync: true,
  world: true,
  payments: true,
};

export type PushRegistrationResult =
  | { status: "registered"; token: string }
  | { status: "expo-go-unsupported" | "physical-device-required" | "permission-denied" | "missing-project-id" | "registration-error"; message?: string };

export type GameNotification = {
  category: NotificationCategory;
  eventKey: string;
  title: string;
  body: string;
  url: NotificationDestination;
  territoryId?: string;
  cooldownMs?: number;
  showWhileActive?: boolean;
  kind?: "payment-approved" | "payment-rejected" | "payment-canceled" | "shield-activated";
};

type NotificationsModule = typeof import("expo-notifications");

const PREFERENCES_KEY = "@paintfoot/notification-preferences-v1";
const EVENT_LOG_KEY = "@paintfoot/notification-events-v1";
const DEVICE_ID_KEY = "@paintfoot/notification-device-id-v1";
const PENDING_TOKEN_KEY = "@paintfoot/pending-push-token-v1";
const EVENT_LOG_LIMIT = 500;

let notificationsModulePromise: Promise<NotificationsModule | null> | null = null;
let notificationHandlerConfigured = false;
let pushTokenListenerConfigured = false;

export function isExpoGoRuntime() {
  return Constants.appOwnership === "expo" || Constants.expoGoConfig != null;
}

async function loadNotificationsModule(): Promise<NotificationsModule | null> {
  // Remote notifications throw inside Expo Go on current Android SDKs. Avoid
  // importing the native module there so the map and the rest of the game load.
  if (isExpoGoRuntime()) return null;
  notificationsModulePromise ??= import("expo-notifications").catch((error) => {
    console.warn("[Push] Módulo de notificaciones no disponible:", error);
    return null;
  });
  return notificationsModulePromise;
}

function channelFor(category: NotificationCategory) {
  if (category === "shields") return NOTIFICATION_CHANNELS.shields;
  if (category === "sync") return NOTIFICATION_CHANNELS.sync;
  if (category === "coins") return NOTIFICATION_CHANNELS.coins;
  if (category === "territories" || category === "world") return NOTIFICATION_CHANNELS.territories;
  if (category === "payments") return NOTIFICATION_CHANNELS.payments;
  return NOTIFICATION_CHANNELS.game;
}

export async function configureNotificationChannels() {
  const Notifications = await loadNotificationsModule();
  if (!Notifications || Platform.OS !== "android") return false;
  const common = {
    importance: Notifications.AndroidImportance.HIGH,
    sound: "default" as const,
    vibrationPattern: [0, 250, 180, 250],
    lightColor: Palette.sky500,
  };
  await Promise.all([
    Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNELS.game, { ...common, name: "Eventos del juego" }),
    Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNELS.shields, { ...common, name: "Escudos y protección" }),
    Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNELS.sync, { ...common, name: "Guardado y sincronización", importance: Notifications.AndroidImportance.DEFAULT }),
    Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNELS.coins, { ...common, name: "Monedas y recompensas", importance: Notifications.AndroidImportance.DEFAULT }),
    Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNELS.territories, { ...common, name: "Territorios y conquistas" }),
    Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNELS.payments, { ...common, name: "Pagos y compras" }),
  ]);
  return true;
}

export async function initializePushNotifications() {
  const Notifications = await loadNotificationsModule();
  if (!Notifications) return false;
  if (!notificationHandlerConfigured) {
    Notifications.setNotificationHandler({
      handleNotification: async () => {
        const shouldDisplay = AppState.currentState !== "active";
        return {
          shouldPlaySound: shouldDisplay,
          shouldSetBadge: false,
          shouldShowBanner: shouldDisplay,
          shouldShowList: shouldDisplay,
        };
      },
    });
    notificationHandlerConfigured = true;
  }
  if (!pushTokenListenerConfigured) {
    Notifications.addPushTokenListener((token) => {
      if (typeof token.data === "string") void persistPushToken(token.data);
    });
    pushTokenListenerConfigured = true;
  }
  await configureNotificationChannels();
  return true;
}

export async function requestNotificationPermission() {
  if (isExpoGoRuntime()) return "expo-go-unsupported" as const;
  const Notifications = await loadNotificationsModule();
  if (!Notifications) return "unavailable" as const;
  await configureNotificationChannels();
  const current = await Notifications.getPermissionsAsync();
  const permission = current.status === "granted" ? current : await Notifications.requestPermissionsAsync();
  return permission.status === "granted" ? "granted" as const : "denied" as const;
}

export async function getNotificationPreferences() {
  const raw = await AsyncStorage.getItem(PREFERENCES_KEY);
  if (!raw) return DEFAULT_NOTIFICATION_PREFERENCES;
  try {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...JSON.parse(raw) } as NotificationPreferences;
  } catch {
    return DEFAULT_NOTIFICATION_PREFERENCES;
  }
}

export async function saveNotificationPreferences(preferences: NotificationPreferences) {
  await AsyncStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  try {
    await requestAuthenticatedPaintFootApi("/push/preferences", preferences);
  } catch {
    // Local preferences remain authoritative while offline.
  }
}

async function deviceInstallationId() {
  const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (stored) return stored;
  const id = Crypto.randomUUID();
  await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}

async function persistPushToken(token: string) {
  try {
    await requestAuthenticatedPaintFootApi("/push/register", {
      expo_push_token: token,
      device_id: await deviceInstallationId(),
      platform: Platform.OS,
    });
    await AsyncStorage.removeItem(PENDING_TOKEN_KEY);
    return true;
  } catch (error) {
    await AsyncStorage.setItem(PENDING_TOKEN_KEY, token);
    console.info("[Push] El token se guardará al recuperar la conexión.", error);
    return false;
  }
}

export async function flushPendingPushRegistration() {
  const pendingToken = await AsyncStorage.getItem(PENDING_TOKEN_KEY);
  if (!pendingToken) return true;
  return persistPushToken(pendingToken);
}

export async function registerPushToken(): Promise<PushRegistrationResult> {
  if (isExpoGoRuntime()) return { status: "expo-go-unsupported" };
  if (!Device.isDevice) return { status: "physical-device-required" };
  try {
    const Notifications = await loadNotificationsModule();
    if (!Notifications) return { status: "registration-error" };
    await initializePushNotifications();
    await flushPendingPushRegistration();
    if (await requestNotificationPermission() !== "granted") return { status: "permission-denied" };
    const projectId =
      process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() ||
      Constants.expoConfig?.extra?.eas?.projectId ||
      Constants.easConfig?.projectId;
    if (!projectId) return { status: "missing-project-id" };
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await persistPushToken(token);
    return { status: "registered", token };
  } catch (error) {
    return { status: "registration-error", message: error instanceof Error ? error.message : String(error) };
  }
}

export const registerForRemotePushNotifications = registerPushToken;

export async function shouldNotify(eventKey: string, cooldownMs = Number.POSITIVE_INFINITY) {
  const now = Date.now();
  let events: Record<string, number> = {};
  try {
    events = JSON.parse((await AsyncStorage.getItem(EVENT_LOG_KEY)) ?? "{}") as Record<string, number>;
  } catch {
    events = {};
  }
  const previous = events[eventKey];
  if (Number.isFinite(previous) && now - previous < cooldownMs) return false;
  const recent = Object.entries({ ...events, [eventKey]: now })
    .sort((first, second) => second[1] - first[1])
    .slice(0, EVENT_LOG_LIMIT);
  await AsyncStorage.setItem(EVENT_LOG_KEY, JSON.stringify(Object.fromEntries(recent)));
  return true;
}

export async function scheduleLocalNotification(
  notification: Omit<GameNotification, "eventKey" | "cooldownMs" | "showWhileActive">,
  trigger: import("expo-notifications").NotificationTriggerInput = null,
) {
  const Notifications = await loadNotificationsModule();
  if (!Notifications || await requestNotificationPermission() !== "granted") return false;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: notification.title,
      body: notification.body,
      data: {
        url: notification.url,
        territoryId: notification.territoryId,
        kind: notification.kind,
      },
      sound: "default",
    },
    trigger: trigger === null && Platform.OS === "android"
      ? { channelId: channelFor(notification.category) }
      : trigger === null
        ? null
        : { ...trigger, channelId: channelFor(notification.category) },
  });
  return true;
}

export async function sendLocalGameNotification(notification: GameNotification) {
  const preferences = await getNotificationPreferences();
  if (!preferences[notification.category]) return false;
  if (!notification.showWhileActive && AppState.currentState === "active") return false;
  if (!await shouldNotify(notification.eventKey, notification.cooldownMs)) return false;
  const scheduled = await scheduleLocalNotification(notification);
  if (scheduled) void recordNotification(notification);
  return scheduled;
}

async function recordNotification(notification: GameNotification) {
  try {
    await requestAuthenticatedPaintFootApi("/push/log", {
      event_key: notification.eventKey,
      category: notification.category,
      title: notification.title,
    });
  } catch {
    // AsyncStorage already guarantees local idempotence while offline.
  }
}

function notificationRoute(url: unknown): NotificationRoute | null {
  if (typeof url !== "string") return null;
  if (url === "paintfoot://shield") return "/payments";
  if (url === "paintfoot://payments") return "/payments";
  if (url === "paintfoot://sync") return "/profile";
  if (url.startsWith("paintfoot://territory/")) {
    const territoryId = url.slice("paintfoot://territory/".length);
    return territoryId ? `/?territoryId=${encodeURIComponent(territoryId)}` : "/";
  }
  if (url === "paintfoot://map" || url === "paintfoot://coins") return "/";
  if (url === "/" || url === "/payments" || url === "/profile") return url;
  return null;
}

export async function handleNotificationResponse(
  notification: import("expo-notifications").Notification,
  openUrl: (url: NotificationRoute) => void,
) {
  const route = notificationRoute(notification.request.content.data?.url);
  if (route) openUrl(route);
}

export async function subscribeToNotificationResponses(openUrl: (url: NotificationRoute) => void) {
  const Notifications = await loadNotificationsModule();
  if (!Notifications) return () => undefined;
  await initializePushNotifications();
  const lastResponse = Notifications.getLastNotificationResponse();
  if (lastResponse?.notification) void handleNotificationResponse(lastResponse.notification, openUrl);
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    void handleNotificationResponse(response.notification, openUrl);
  });
  return () => subscription.remove();
}

type ScheduledNotifications = Pick<
  NotificationsModule,
  "getAllScheduledNotificationsAsync" | "cancelScheduledNotificationAsync"
>;

/** Cancela avisos programados que ya no corresponden (escudo renovado, quitado, etc.). */
async function cancelStaleScheduled(
  Notifications: ScheduledNotifications,
  kind: "shield" | "free-shield",
  shouldCancel: (data: Record<string, unknown>) => boolean,
) {
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      scheduled
        .filter((item) => {
          const data = (item.content.data ?? {}) as Record<string, unknown>;
          return data.kind === kind && shouldCancel(data);
        })
        .map((item) => Notifications.cancelScheduledNotificationAsync(item.identifier)),
    );
  } catch (error) {
    console.info("[Push] No se pudieron cancelar avisos anteriores:", error);
  }
}

/** Úsala cuando un escudo se quita o se reemplaza: borra sus avisos pendientes. */
export async function cancelShieldNotifications(territoryId: string) {
  const Notifications = await loadNotificationsModule();
  if (!Notifications) return;
  await cancelStaleScheduled(Notifications, "shield", (data) => data.territoryId === territoryId);
}

export async function scheduleShieldNotifications(territoryId: string, startedAt: number, expiresAt: number) {
  const Notifications = await loadNotificationsModule();
  if (!Notifications || await requestNotificationPermission() !== "granted") return false;
  const preferences = await getNotificationPreferences();
  if (!preferences.shields) return false;
  await cancelStaleScheduled(
    Notifications,
    "shield",
    (data) => data.territoryId === territoryId && data.expiresAt !== expiresAt,
  );
  const now = Date.now();
  const totalDuration = expiresAt - startedAt;
  const items = [
    { key: `shield_warning:${territoryId}:${expiresAt}`, at: startedAt + totalDuration * 0.7, title: "Escudo por agotarse", body: "Tu protección está por terminar." },
    { key: `shield_expired:${territoryId}:${expiresAt}`, at: expiresAt, title: "Escudo agotado", body: "Tu territorio ya no está protegido." },
  ];
  for (const item of items) {
    if (item.at <= now + 1_000 || !await shouldNotify(item.key)) continue;
    await Notifications.scheduleNotificationAsync({
      content: { title: item.title, body: item.body, data: { url: "paintfoot://shield", territoryId, kind: "shield", expiresAt }, sound: "default" },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(item.at), channelId: NOTIFICATION_CHANNELS.shields },
    });
  }
  return true;
}

export async function scheduleFreeShieldAvailableNotification(availableAt: number) {
  const Notifications = await loadNotificationsModule();
  if (!Notifications || await requestNotificationPermission() !== "granted") return false;
  const preferences = await getNotificationPreferences();
  const eventKey = `shield_free_available:${availableAt}`;
  if (!preferences.shields || !await shouldNotify(eventKey)) return false;
  await cancelStaleScheduled(
    Notifications,
    "free-shield",
    (data) => data.availableAt !== availableAt,
  );
  const trigger: import("expo-notifications").NotificationTriggerInput = availableAt > Date.now() + 1_000
    ? {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(availableAt),
        channelId: NOTIFICATION_CHANNELS.shields,
      }
    : null;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "Escudo disponible",
      body: "Tienes un escudo gratis de 1 hora.",
      data: { url: "paintfoot://shield", kind: "free-shield", availableAt },
      sound: "default",
    },
    trigger,
  });
  return true;
}
