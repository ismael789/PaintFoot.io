export type CapabilityDisplayStatus =
  | "available"
  | "active"
  | "unavailable"
  | "temporarily-unavailable"
  | "apk-only";

export function resolveCapabilityStatus({
  requiresNativeModule,
  nativeModuleAvailable,
  detected,
  active,
  temporarilyUnavailable = false,
}: {
  requiresNativeModule: boolean;
  nativeModuleAvailable: boolean;
  detected: boolean | null;
  active: boolean;
  temporarilyUnavailable?: boolean;
}): CapabilityDisplayStatus {
  if (requiresNativeModule && !nativeModuleAvailable) return "apk-only";
  if (temporarilyUnavailable) return "temporarily-unavailable";
  if (detected === false) return "unavailable";
  return active ? "active" : "available";
}

export function canUseTerritoryTracking({
  gpsAvailable,
  mapMatchingAvailable,
}: {
  gpsAvailable: boolean;
  mapMatchingAvailable: boolean;
}) {
  return gpsAvailable && mapMatchingAvailable;
}

export function averageAvailableSignals(
  signals: Array<number | null | undefined>,
  fallback = 0.5,
) {
  const available = signals.filter(
    (value): value is number => value !== null && value !== undefined,
  );
  if (available.length === 0) return fallback;
  return (
    available.reduce((total, value) => total + value, 0) / available.length
  );
}
