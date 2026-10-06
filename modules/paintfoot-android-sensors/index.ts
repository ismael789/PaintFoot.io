import {
  type EventSubscription,
  requireOptionalNativeModule,
} from "expo-modules-core";
import { Platform } from "react-native";

export type AndroidSensorId =
  | "proximity"
  | "gravity"
  | "linearAcceleration"
  | "rotationVector"
  | "gameRotationVector"
  | "geomagneticRotationVector"
  | "stepDetector"
  | "significantMotion";

export interface AndroidSensorCapability {
  id: AndroidSensorId;
  androidType: number;
  available: boolean;
  name?: string;
  vendor?: string;
  version?: number;
  powerMa?: number;
  resolution?: number;
  maximumRange?: number;
  reportingMode?: number;
  wakeUpSensor?: boolean;
}

export interface AndroidSensorEvent {
  id: AndroidSensorId;
  values: number[];
  timestamp: number;
  maximumRange: number;
  triggered: boolean;
  headingDegrees?: number;
  near?: boolean;
}

interface NativeAndroidSensorsModule {
  getCapabilitiesAsync(): Promise<AndroidSensorCapability[]>;
  startAsync(ids: AndroidSensorId[], updateIntervalMs: number): Promise<AndroidSensorId[]>;
  stopAsync(): Promise<void>;
  addListener(
    eventName: "onSensorChanged",
    listener: (event: AndroidSensorEvent) => void,
  ): EventSubscription;
}

const nativeModule =
  Platform.OS === "android"
    ? requireOptionalNativeModule<NativeAndroidSensorsModule>(
        "PaintFootAndroidSensors",
      )
    : null;

export const isAndroidNativeSensorsModuleAvailable = nativeModule !== null;

export async function getAndroidSensorCapabilities() {
  if (!nativeModule) return null;
  return nativeModule.getCapabilitiesAsync();
}

export async function startAndroidSensors(
  ids: AndroidSensorId[],
  updateIntervalMs: number,
  listener: (event: AndroidSensorEvent) => void,
) {
  if (!nativeModule) return null;
  const subscription = nativeModule.addListener("onSensorChanged", listener);
  try {
    const activeIds = await nativeModule.startAsync(ids, updateIntervalMs);
    return { activeIds, subscription };
  } catch (error) {
    subscription.remove();
    throw error;
  }
}

export async function stopAndroidSensors() {
  if (nativeModule) await nativeModule.stopAsync();
}
