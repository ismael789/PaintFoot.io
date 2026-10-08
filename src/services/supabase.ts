import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import 'react-native-url-polyfill/auto';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? '';
const supabasePublishableKey =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ??
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ??
  '';

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        storage: Platform.OS === 'web' ? undefined : AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null;

export type SupabaseConnectionStatus = {
  configured: boolean;
  connected: boolean;
  serverTimeMs?: number;
  error?: string;
};

export function getSupabaseClient(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      'Supabase no esta configurado. Define EXPO_PUBLIC_SUPABASE_URL y EXPO_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }

  return supabase;
}

/** Comprueba el proyecto sin consultar ni modificar tablas. */
export async function checkSupabaseConnection(): Promise<SupabaseConnectionStatus> {
  if (!isSupabaseConfigured) {
    return {
      configured: false,
      connected: false,
      error: 'Faltan las variables publicas de Supabase.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: supabasePublishableKey },
      signal: controller.signal,
    });

    const serverTime = Date.parse(response.headers.get('date') ?? '');
    return response.ok
      ? {
          configured: true,
          connected: true,
          serverTimeMs: Number.isFinite(serverTime) ? serverTime : undefined,
        }
      : {
          configured: true,
          connected: false,
          error: `Supabase respondio con HTTP ${response.status}.`,
        };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      error: error instanceof Error ? error.message : 'No fue posible conectar con Supabase.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Mantiene los tokens actualizados solamente mientras la app esta activa. */
export function startSupabaseSessionLifecycle(): () => void {
  if (!supabase || Platform.OS === 'web') {
    return () => undefined;
  }

  const updateAutoRefresh = (state: AppStateStatus) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  };

  updateAutoRefresh(AppState.currentState);
  const subscription = AppState.addEventListener('change', updateAutoRefresh);

  return () => {
    subscription.remove();
    supabase.auth.stopAutoRefresh();
  };
}
