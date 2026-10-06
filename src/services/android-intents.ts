import * as Application from "expo-application";
import * as IntentLauncher from "expo-intent-launcher";
import { Linking, Platform } from "react-native";

export async function openLocationSettingsIntent() {
  if (Platform.OS === "android") {
    await IntentLauncher.startActivityAsync(
      IntentLauncher.ActivityAction.LOCATION_SOURCE_SETTINGS,
    );
    return;
  }

  await Linking.openSettings();
}

export async function openNotificationSettingsIntent() {
  if (Platform.OS === "android" && Application.applicationId) {
    await IntentLauncher.startActivityAsync(
      IntentLauncher.ActivityAction.APP_NOTIFICATION_SETTINGS,
      {
        extra: {
          "android.provider.extra.APP_PACKAGE": Application.applicationId,
        },
      },
    );
    return;
  }

  await Linking.openSettings();
}
