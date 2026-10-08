import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";

const BIOMETRIC_PURCHASE_PREFERENCE_KEY =
  "@paintfoot/biometric-purchase-confirmation-v1";

export interface BiometricPurchaseSettings {
  available: boolean;
  enabled: boolean;
  enrolled: boolean;
  hasHardware: boolean;
  deviceCredentialAvailable: boolean;
  authenticationTypes: LocalAuthentication.AuthenticationType[];
}

export type PurchaseAuthenticationResult =
  | { continueToPayment: true; reason: "authenticated" | "disabled" | "unavailable" }
  | { continueToPayment: false; reason: "canceled" | "failed" };

async function readStoredPreference() {
  const stored = await AsyncStorage.getItem(BIOMETRIC_PURCHASE_PREFERENCE_KEY);
  if (stored === null) return null;
  return stored === "true";
}

export async function getBiometricPurchaseSettings(): Promise<BiometricPurchaseSettings> {
  if (Platform.OS === "web") {
    return {
      available: false,
      enabled: false,
      enrolled: false,
      hasHardware: false,
      deviceCredentialAvailable: false,
      authenticationTypes: [],
    };
  }

  try {
    const [hasHardware, enrolled, authenticationTypes, securityLevel, storedPreference] =
      await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
        LocalAuthentication.supportedAuthenticationTypesAsync(),
        LocalAuthentication.getEnrolledLevelAsync(),
        readStoredPreference(),
      ]);
    const deviceCredentialAvailable =
      securityLevel !== LocalAuthentication.SecurityLevel.NONE;
    const available = (hasHardware && enrolled) || deviceCredentialAvailable;
    return {
      available,
      enabled: available && (storedPreference ?? true),
      enrolled,
      hasHardware,
      deviceCredentialAvailable,
      authenticationTypes,
    };
  } catch {
    return {
      available: false,
      enabled: false,
      enrolled: false,
      hasHardware: false,
      deviceCredentialAvailable: false,
      authenticationTypes: [],
    };
  }
}

export async function setBiometricPurchaseEnabled(enabled: boolean) {
  await AsyncStorage.setItem(
    BIOMETRIC_PURCHASE_PREFERENCE_KEY,
    String(enabled),
  );
}

export async function authenticateShieldPurchase(): Promise<PurchaseAuthenticationResult> {
  const settings = await getBiometricPurchaseSettings();
  if (!settings.available) {
    return { continueToPayment: true, reason: "unavailable" };
  }
  if (!settings.enabled) {
    return { continueToPayment: true, reason: "disabled" };
  }

  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "Confirma la compra",
      promptSubtitle: "Autoriza el pago seguro de tu escudo",
      promptDescription: "Usa tu huella, rostro o bloqueo del dispositivo.",
      cancelLabel: "Cancelar",
      fallbackLabel: "Usar PIN o patrón",
      disableDeviceFallback: false,
      biometricsSecurityLevel: "weak",
      requireConfirmation: true,
    });

    if (result.success) {
      return { continueToPayment: true, reason: "authenticated" };
    }

    const canceledErrors = new Set([
      "user_cancel",
      "app_cancel",
      "system_cancel",
      "user_fallback",
    ]);
    return {
      continueToPayment: false,
      reason: canceledErrors.has(result.error) ? "canceled" : "failed",
    };
  } catch {
    return { continueToPayment: false, reason: "failed" };
  }
}
