import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

import { buildEndpointCandidates } from "@/services/network-endpoints";

const SESSION_STORAGE_KEY = "@paintfoot/custom-auth-session";

export interface PaintFootUser {
  id: string;
  email: string;
  name?: string;
  age?: number;
}

export interface PaintFootSession {
  accessToken: string;
  expiresAt: number;
  user: PaintFootUser;
}

type AuthResponse = { session: PaintFootSession };
type AuthListener = (session: PaintFootSession | null) => void;

const listeners = new Set<AuthListener>();
let sessionCache: PaintFootSession | null | undefined;
let resolvedAuthApiUrl: string | null = null;

function authApiUrls() {
  return buildEndpointCandidates(
    process.env.EXPO_PUBLIC_AUTH_API_URL,
    Constants.expoConfig?.hostUri,
    { scheme: "http", defaultPort: 4001, fallbackPath: "/api/auth" },
  );
}

async function resolveAuthApiUrl() {
  if (resolvedAuthApiUrl) return resolvedAuthApiUrl;
  for (const candidate of authApiUrls()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(`${candidate}/health`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.headers.get("X-PaintFoot-Server") === "auth-api") {
        resolvedAuthApiUrl = candidate;
        return candidate;
      }
    } catch {
      // Try the next local address/port.
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(
    "No se encontró el servidor de cuentas. Inicia PaintFoot con npm start.",
  );
}

function normalizedCredentials(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    throw new Error("Escribe un correo electrónico válido.");
  }
  if (password.length < 8) {
    throw new Error("La contraseña debe tener al menos 8 caracteres.");
  }
  return { email: normalizedEmail, password };
}

async function requestAuth(
  path: string,
  credentials?: Record<string, string | number>,
) {
  const baseUrl = await resolveAuthApiUrl();
  const session = await getPersistedAuthSession();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
    },
    body: credentials ? JSON.stringify(credentials) : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    session?: PaintFootSession;
  };
  if (!response.ok || !body.session) {
    throw new Error(body.error ?? "No fue posible completar la operación.");
  }
  await AsyncStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(body.session));
  sessionCache = body.session;
  listeners.forEach((listener) => listener(body.session!));
  return body.session;
}

export async function requestAuthenticatedPaintFootApi<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const baseUrl = await resolveAuthApiUrl();
  const session = await getPersistedAuthSession();
  if (!session) throw new Error("Inicia sesión para sincronizar esta configuración.");
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "No fue posible sincronizar los datos.");
  return result;
}

export async function registerWithEmail(
  name: string,
  age: string,
  email: string,
  password: string,
  passwordConfirmation: string,
) {
  const credentials = normalizedCredentials(email, password);
  return {
    session: await requestAuth("/register", {
      ...credentials,
      name: name.trim(),
      age: Number(age),
      passwordConfirmation,
    }),
  };
}

export async function loginWithEmail(email: string, password: string) {
  return { session: await requestAuth("/login", normalizedCredentials(email, password)) };
}

export async function logoutPaintFootAccount() {
  const session = await getPersistedAuthSession();
  if (session) {
    try {
      const baseUrl = await resolveAuthApiUrl();
      await fetch(`${baseUrl}/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
    } finally {
      await AsyncStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }
  sessionCache = null;
  listeners.forEach((listener) => listener(null));
}

export async function getPersistedAuthSession(): Promise<PaintFootSession | null> {
  if (sessionCache !== undefined) {
    if (sessionCache && sessionCache.expiresAt <= Date.now()) {
      await logoutPaintFootAccount();
      return null;
    }
    return sessionCache;
  }
  const raw = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    sessionCache = null;
    return null;
  }
  try {
    const session = JSON.parse(raw) as PaintFootSession;
    sessionCache = session;
    if (session.expiresAt <= Date.now()) {
      await logoutPaintFootAccount();
      return null;
    }
    return session;
  } catch {
    await AsyncStorage.removeItem(SESSION_STORAGE_KEY);
    sessionCache = null;
    return null;
  }
}

export function subscribeToAuthSession(listener: AuthListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
