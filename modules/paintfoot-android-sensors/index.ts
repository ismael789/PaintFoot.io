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

export interface AndroidSensorAccuracyEvent {
  id: AndroidSensorId;
  accuracy: number;
  timestamp: number;
}

interface NativeAndroidSensorsModule {
  getCapabilitiesAsync(): Promise<AndroidSensorCapability[]>;
  startAsync(ids: AndroidSensorId[], updateIntervalMs: number): Promise<AndroidSensorId[]>;
  stopAsync(): Promise<void>;
  getRuntimeStorageInfoAsync(): Promise<AndroidRuntimeStorageInfo>;
  addListener(
    eventName: "onSensorChanged" | "onSensorAccuracyChanged",
    listener:
      | ((event: AndroidSensorEvent) => void)
      | ((event: AndroidSensorAccuracyEvent) => void),
  ): EventSubscription;
}

export interface AndroidRuntimeStorageInfo {
  elapsedRealtimeMs: number;
  bootId: string;
  externalFilesUri: string | null;
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
  accuracyListener?: (event: AndroidSensorAccuracyEvent) => void,
) {
  if (!nativeModule) return null;
  const readingSubscription = nativeModule.addListener(
    "onSensorChanged",
    listener,
  );
  const accuracySubscription = accuracyListener
    ? nativeModule.addListener("onSensorAccuracyChanged", accuracyListener)
    : null;
  const subscription = {
    remove() {
      readingSubscription.remove();
      accuracySubscription?.remove();
    },
  };
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

export async function getAndroidRuntimeStorageInfo() {
  if (!nativeModule) return null;
  return nativeModule.getRuntimeStorageInfoAsync();
}
