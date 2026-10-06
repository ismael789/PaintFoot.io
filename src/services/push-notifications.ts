import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";

export const GAME_EVENTS_CHANNEL_ID = "game-events";

export type PushRegistrationResult =
  | { status: "registered"; token: string }
  | {
      status:
        | "expo-go-unsupported"
        | "physical-device-required"
        | "permission-denied"
        | "missing-project-id"
        | "registration-error";
      message?: string;
    };

type NotificationsModule = typeof import("expo-notifications");

let notificationsModulePromise: Promise<NotificationsModule | null> | null =
  null;
let notificationHandlerConfigured = false;

export function isExpoGoRuntime() {
  return Constants.appOwnership === "expo" || Constants.expoGoConfig != null;
}

async function loadNotificationsModule(): Promise<NotificationsModule | null> {
  if (isExpoGoRuntime()) return null;

  notificationsModulePromise ??= import("expo-notifications").catch((error) => {
    console.warn("No se pudo cargar expo-notifications:", error);
    return null;
  });
  return notificationsModulePromise;
}

export async function initializePushNotifications() {
  const notifications = await loadNotificationsModule();
  if (!notifications) return false;

  if (!notificationHandlerConfigured) {
    notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    notificationHandlerConfigured = true;
  }
  return true;
}

export async function subscribeToNotificationResponses(
  openUrl: (url: "/" | "/explore") => void,
) {
  const notifications = await loadNotificationsModule();
  if (!notifications) return () => undefined;

  await initializePushNotifications();

  const openNotificationDestination = (
    notification: import("expo-notifications").Notification,
  ) => {
    const url = notification.request.content.data?.url;
    if (url === "/" || url === "/explore") openUrl(url);
  };

  const lastResponse = notifications.getLastNotificationResponse();
  if (lastResponse?.notification) {
    openNotificationDestination(lastResponse.notification);
  }

  const subscription =
    notifications.addNotificationResponseReceivedListener((response) =>
      openNotificationDestination(response.notification),
    );

  return () => subscription.remove();
}

export async function registerForRemotePushNotifications(): Promise<PushRegistrationResult> {
  if (isExpoGoRuntime()) {
    return { status: "expo-go-unsupported" };
  }

  if (!Device.isDevice) {
    return { status: "physical-device-required" };
  }

  try {
    const Notifications = await loadNotificationsModule();
    if (!Notifications) {
      return {
        status: "registration-error",
        message: "expo-notifications no esta disponible en este build.",
      };
    }
    await initializePushNotifications();

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(
        GAME_EVENTS_CHANNEL_ID,
        {
          name: "Eventos de PaintFoot.io",
          importance: Notifications.AndroidImportance.MAX,
          sound: "default",
          vibrationPattern: [0, 250, 250, 250],
          lightColor: "#208AEF",
        },
      );
    }

    const currentPermission = await Notifications.getPermissionsAsync();
    const finalPermission =
      currentPermission.status === "granted"
        ? currentPermission
        : await Notifications.requestPermissionsAsync();

    if (finalPermission.status !== "granted") {
      return { status: "permission-denied" };
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;

    if (!projectId) {
      return { status: "missing-project-id" };
    }

    const token = (
      await Notifications.getExpoPushTokenAsync({ projectId })
    ).data;

    return { status: "registered", token };
  } catch (error) {
    return {
      status: "registration-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function scheduleShieldNotifications(
  territoryId: string,
  startedAt: number,
  expiresAt: number,
) {
  const Notifications = await loadNotificationsModule();
  if (!Notifications) return false;
  await initializePushNotifications();
  const permission = await Notifications.getPermissionsAsync();
  const finalPermission =
    permission.status === "granted"
      ? permission
      : await Notifications.requestPermissionsAsync();
  if (finalPermission.status !== "granted") return false;

  const now = Date.now();
  const totalDuration = expiresAt - startedAt;
  const notifications = [
    {
      at: startedAt + totalDuration * 0.7,
      title: "Tu escudo se esta agotando",
      body: "Queda 30 % de proteccion en tu territorio.",
    },
    {
      at: expiresAt - 10 * 60 * 1_000,
      title: "Quedan 10 minutos de escudo",
      body: "Tu territorio pronto volvera a ser conquistable.",
    },
    {
      at: expiresAt,
      title: "Escudo agotado",
      body: "Tu territorio ya no esta protegido.",
    },
  ];

  await Promise.all(
    notifications
      .filter((item) => item.at > now + 1_000)
      .map((item) =>
        Notifications.scheduleNotificationAsync({
          content: {
            title: item.title,
            body: item.body,
            data: { url: "/", territoryId },
            sound: "default",
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: new Date(item.at),
            channelId: GAME_EVENTS_CHANNEL_ID,
          },
        }),
      ),
  );
  return true;
}
