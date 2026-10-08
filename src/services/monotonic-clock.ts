import { getAndroidRuntimeStorageInfo } from "../../modules/paintfoot-android-sensors";

export type MonotonicSource =
  | "android_elapsed_realtime"
  | "js_monotonic_fallback";

export interface MonotonicSnapshot {
  monotonicTimestamp: number;
  monotonicSource: MonotonicSource;
  bootId: string;
}

const jsStartedAt =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : 0;
const fallbackBootId = `js-run-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 10)}`;

let nativeBase: {
  elapsedRealtimeMs: number;
  performanceMs: number;
  bootId: string;
} | null = null;
let externalFilesUri: string | null = null;
let initializationPromise: Promise<void> | null = null;

function performanceNow() {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function initializeMonotonicClock() {
  initializationPromise ??= getAndroidRuntimeStorageInfo()
    .then((info) => {
      if (!info || !Number.isFinite(info.elapsedRealtimeMs)) return;
      nativeBase = {
        elapsedRealtimeMs: info.elapsedRealtimeMs,
        performanceMs: performanceNow(),
        bootId: info.bootId,
      };
      externalFilesUri = info.externalFilesUri;
    })
    .catch(() => undefined);
  return initializationPromise;
}

export function getMonotonicSnapshot(): MonotonicSnapshot {
  const now = performanceNow();
  if (nativeBase) {
    return {
      monotonicTimestamp:
        nativeBase.elapsedRealtimeMs + (now - nativeBase.performanceMs),
      monotonicSource: "android_elapsed_realtime",
      bootId: nativeBase.bootId,
    };
  }
  return {
    monotonicTimestamp: Math.max(0, now - jsStartedAt),
    monotonicSource: "js_monotonic_fallback",
    bootId: fallbackBootId,
  };
}

export function getAppSpecificExternalFilesUri() {
  return externalFilesUri;
}

