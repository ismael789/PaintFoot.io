type DebugScope =
  | "GPS"
  | "ROAD"
  | "NODE"
  | "LOOP"
  | "TERRITORY";

export function debugLog(
  scope: DebugScope,
  message: string,
  details?: unknown,
) {
  const isDevelopment = (
    globalThis as typeof globalThis & { __DEV__?: boolean }
  ).__DEV__;
  if (isDevelopment === false) return;

  if (details === undefined) {
    console.log(`[${scope}] ${message}`);
  } else {
    console.log(`[${scope}] ${message}`, details);
  }
}
