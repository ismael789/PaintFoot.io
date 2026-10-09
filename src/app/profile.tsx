import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { PaintFootSession as Session } from "@/services/auth";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Switch,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  getOrCreatePlayerProfile,
  getActivePlayerId,
  PLAYER_COLORS,
  updatePlayerProfile,
} from "@/services/player-profile";
import {
  clearRegenerableRoadCache,
  getOfflineStorageStats,
  type OfflineStorageStats,
} from "@/services/offline-storage";
import {
  appendStoredTerritories,
  getStoredTerritories,
} from "@/services/territory-storage";
import { isTerritoryShieldActive } from "@/services/territory-shields";
import { getCoinBalance, subscribeToCoinBalance } from "@/services/coins";
import {
  getLatestTrackingSession,
  getThemePreference,
  saveThemePreference,
} from "@/services/tracking-stats";
import type {
  PlayerProfile,
  Territory,
  ThemePreference,
  TrackingSessionSummary,
} from "@/types/game";
import {
  getPersistedAuthSession,
  loginWithEmail,
  logoutPaintFootAccount,
  registerWithEmail,
  subscribeToAuthSession,
} from "@/services/auth";
import { synchronizePendingOperations } from "@/services/offline-sync";
import { synchronizeGlobalPlayerProfile } from "@/services/global-multiplayer";
import {
  DEFAULT_MULTIPLAYER_PREFERENCES,
  getMultiplayerPreferences,
  saveMultiplayerPreferences,
  type MultiplayerPreferences,
} from "@/services/multiplayer-preferences";
import {
  backgroundStatusText,
  getGameSystemStatus,
  openGameNotificationSettings,
  pushStatusText,
  retryRoadMatching,
  roadStatusText,
  selectGameTheme,
  subscribeToGameSystemStatus,
  worldStatusText,
} from "@/services/game-system-status";
import { sensorCapabilityManager } from "@/services/sensor-capabilities";
import { OfflineSimulationScreen } from "@/components/offline-simulation-screen";
import { showFeedback } from "@/services/global-feedback";
import { getAvailableStorageBytes } from "@/services/app-file-storage";
import { REGIONAL_CACHE_CONFIG } from "@/config/offline";
import {
  getBiometricPurchaseSettings,
  setBiometricPurchaseEnabled,
  type BiometricPurchaseSettings,
} from "@/services/biometric-auth";

const OFFLINE_SIMULATION_ENABLED =
  __DEV__ && process.env.EXPO_PUBLIC_ENABLE_OFFLINE_SIMULATION === "true";

function formatDuration(milliseconds: number) {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours > 0 ? `${hours} h ${remainingMinutes} min` : `${minutes} min`;
}

function formatStorageSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const compactLayout = width < 380 || fontScale > 1.15;
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [latestSession, setLatestSession] =
    useState<TrackingSessionSummary | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<(typeof PLAYER_COLORS)[number]>(
    PLAYER_COLORS[0],
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [storageStats, setStorageStats] =
    useState<OfflineStorageStats | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [authSession, setAuthSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [coinBalance, setCoinBalance] = useState(0);
  const [multiplayerPreferences, setMultiplayerPreferences] =
    useState<MultiplayerPreferences>(DEFAULT_MULTIPLAYER_PREFERENCES);
  const [themePreference, setThemePreference] =
    useState<ThemePreference>("auto");
  const [simulationVisible, setSimulationVisible] = useState(false);
  const [biometricSettings, setBiometricSettings] =
    useState<BiometricPurchaseSettings | null>(null);
  const setMessage = useCallback((nextMessage: string | null) => {
    if (!nextMessage) return;
    const failed = /no se pudo|no pudo|error|fall/i.test(nextMessage);
    showFeedback({
      id: "profile-action",
      type: failed ? "error" : "success",
      message: nextMessage.includes("limpiad")
        ? "Caché liberada"
        : nextMessage.replace(/\.$/, ""),
    });
  }, []);
  const setAccountMessage = useCallback((nextMessage: string | null) => {
    if (!nextMessage) return;
    const failed = /no fue posible|error|revisa tus datos/i.test(nextMessage);
    showFeedback({
      id: "account-action",
      type: failed ? "error" : "success",
      message: nextMessage.replace(/\.$/, ""),
    });
  }, []);
  const systemStatus = useSyncExternalStore(
    subscribeToGameSystemStatus,
    getGameSystemStatus,
    getGameSystemStatus,
  );
  const sensorStates = useSyncExternalStore(
    sensorCapabilityManager.subscribe,
    sensorCapabilityManager.getSnapshot,
    sensorCapabilityManager.getSnapshot,
  );

  useEffect(() => {
    void getPersistedAuthSession().then(setAuthSession);
    void getCoinBalance().then(setCoinBalance);
    const unsubscribeAuth = subscribeToAuthSession((session) => setAuthSession(session));
    const unsubscribeCoins = subscribeToCoinBalance(setCoinBalance);
    return () => {
      unsubscribeAuth();
      unsubscribeCoins();
    };
  }, []);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [nextProfile, storedTerritories, session, nextStorageStats, nextPreferences, nextTheme, nextBiometricSettings] = await Promise.all([
        getOrCreatePlayerProfile(),
        getStoredTerritories(),
        getLatestTrackingSession(),
        getOfflineStorageStats(),
        getMultiplayerPreferences(),
        getThemePreference(),
        getBiometricPurchaseSettings(),
      ]);
      void sensorCapabilityManager.refresh();
      setProfile(nextProfile);
      setName(nextProfile.name);
      setColor(nextProfile.color as (typeof PLAYER_COLORS)[number]);
      setTerritories(
        storedTerritories.filter(
          (territory) => territory.playerId === getActivePlayerId(nextProfile),
        ),
      );
      setLatestSession(session);
      setStorageStats(nextStorageStats);
      if (getAvailableStorageBytes() < REGIONAL_CACHE_CONFIG.lowStorageThresholdBytes) {
        showFeedback({
          id: "storage-low",
          type: "warning",
          message: "Poco almacenamiento disponible",
          cooldownMs: 300_000,
        });
      }
      setMultiplayerPreferences(nextPreferences);
      setThemePreference(nextTheme);
      setBiometricSettings(nextBiometricSettings);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "No se pudo cargar el perfil.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadProfile();
    }, [loadProfile]),
  );

  const statistics = useMemo(() => {
    const now = Date.now();
    return {
      areaM2: territories.reduce(
        (total, territory) => total + territory.areaM2,
        0,
      ),
      protectedTerritories: territories.filter((territory) =>
        isTerritoryShieldActive(territory.shield, now),
      ).length,
    };
  }, [territories]);

  const save = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const registeredName = authSession?.user.name ?? name;
      const localUpdated = await updatePlayerProfile({
        name: registeredName,
        color,
      });
      const updated = authSession
        ? await synchronizeGlobalPlayerProfile(localUpdated)
        : localUpdated;
      const updatedTerritories = territories.map((territory) => ({
        ...territory,
        owner: updated.name,
        color: updated.color,
        playerColor: updated.color,
      }));
      if (updatedTerritories.length > 0) {
        await appendStoredTerritories(updatedTerritories);
        setTerritories(updatedTerritories);
      }
      setProfile(updated);
      setName(updated.name);
      setMessage("Perfil guardado correctamente.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "No se pudo guardar el perfil.",
      );
    } finally {
      setSaving(false);
    }
  }, [authSession, color, name, territories]);

  const updateMultiplayerPreference = useCallback(
    (key: keyof MultiplayerPreferences, value: boolean) => {
      setMultiplayerPreferences((current) => {
        const next = { ...current, [key]: value };
        void saveMultiplayerPreferences(next);
        return next;
      });
    },
    [],
  );

  const updateThemePreference = useCallback((preference: ThemePreference) => {
    setThemePreference(preference);
    selectGameTheme(preference);
    void saveThemePreference(preference);
  }, []);

  const updateBiometricPurchasePreference = useCallback(async (enabled: boolean) => {
    if (!biometricSettings?.available) return;
    const previous = biometricSettings;
    setBiometricSettings({ ...biometricSettings, enabled });
    try {
      await setBiometricPurchaseEnabled(enabled);
      showFeedback({
        id: "biometric-purchase-setting",
        type: "success",
        message: enabled
          ? "Confirmación biométrica activada"
          : "Confirmación biométrica desactivada",
      });
    } catch {
      setBiometricSettings(previous);
      showFeedback({
        id: "biometric-purchase-setting",
        type: "error",
        message: "No se pudo guardar esta preferencia",
      });
    }
  }, [biometricSettings]);

  const clearCache = useCallback(() => {
    Alert.alert(
      "Limpiar caché",
      "Se eliminarán solamente mapas y calles regenerables. Tus territorios y recorridos permanecerán guardados.",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Limpiar",
          style: "destructive",
          onPress: () => {
            setClearingCache(true);
            void clearRegenerableRoadCache()
              .then(getOfflineStorageStats)
              .then((stats) => {
                setStorageStats(stats);
                setMessage("Caché regenerable limpiada correctamente.");
              })
              .catch(() => {
                setMessage("La caché no pudo limpiarse en este momento.");
              })
              .finally(() => setClearingCache(false));
          },
        },
      ],
    );
  }, []);

  const authenticate = useCallback(async (mode: "login" | "register") => {
    setAccountBusy(true);
    setAccountMessage(null);
    try {
      const result = mode === "login"
        ? await loginWithEmail(email, password)
        : await registerWithEmail(profile?.name ?? "", "18", email, password, password);
      setAuthSession(result.session);
      setPassword("");
      setAccountMessage(
        result.session
          ? "Cuenta lista. Tu progreso pendiente se respaldará automáticamente."
          : "Cuenta creada. Revisa tu correo para confirmar el acceso.",
      );
      if (result.session) {
        void synchronizePendingOperations();
        const localProfile = await getOrCreatePlayerProfile();
        const globalProfile = await synchronizeGlobalPlayerProfile(localProfile);
        setProfile(globalProfile);
        setName(globalProfile.name);
        setColor(globalProfile.color as (typeof PLAYER_COLORS)[number]);
      }
    } catch (error) {
      setAccountMessage(
        error instanceof Error
          ? error.message
          : "No fue posible completar el acceso. Revisa tu conexión.",
      );
    } finally {
      setAccountBusy(false);
    }
  }, [email, password]);

  const logout = useCallback(async () => {
    setAccountBusy(true);
    setAccountMessage(null);
    try {
      await logoutPaintFootAccount();
      setAuthSession(null);
      setAccountMessage("Sesión cerrada. Tus datos locales siguen guardados.");
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "No fue posible cerrar la sesión.");
    } finally {
      setAccountBusy(false);
    }
  }, []);

  if (loading || !profile) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator color="#40C4FF" size="large" />
        <Text style={styles.loadingText}>Cargando perfil...</Text>
      </View>
    );
  }

  const initial = profile.name.trim().charAt(0).toUpperCase() || "J";
  const availableSensorCount = sensorStates.filter(
    (sensor) => sensor.available === true,
  ).length;
  const activeSensorCount = sensorStates.filter((sensor) => sensor.active).length;
  const gpsStatus = !systemStatus.gpsAvailable
    ? "Esperando ubicacion"
    : systemStatus.gpsAccuracy === null
      ? "Disponible"
      : `Activo · precision ±${Math.round(systemStatus.gpsAccuracy)} m`;

  return (
    <>
    <ScrollView
      style={styles.screen}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 110 },
      ]}
    >
      <View style={[styles.header, compactLayout && styles.headerCompact]}>
        <View style={[styles.avatar, { backgroundColor: color }]}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>{profile.name}</Text>
          <Text style={styles.subtitle}>Perfil de jugador PaintFoot.io</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Datos del jugador</Text>
        <Text style={styles.label}>Nombre registrado del jugador</Text>
        <TextInput
          value={authSession?.user.name ?? name}
          maxLength={30}
          autoCapitalize="words"
          autoCorrect={false}
          editable={false}
          placeholder="Nombre registrado"
          placeholderTextColor="#6F7897"
          selectionColor="#40C4FF"
          style={styles.input}
        />
        <Text style={styles.identifierHelp}>
          Este nombre se tomó del registro y se usa para identificarte en el mapa.
        </Text>

        <Text style={styles.label}>Color global en el mapa</Text>
        {profile.globalId ? (
          <View style={styles.globalColorRow}>
            <View style={[styles.colorButton, { backgroundColor: profile.color }]} />
            <Text style={styles.identifierHelp}>
              Este color pertenece a tu cuenta y todos los jugadores te ven igual.
            </Text>
          </View>
        ) : (
        <View style={styles.colorRow}>
          {PLAYER_COLORS.map((playerColor) => (
            <Pressable
              key={playerColor}
              accessibilityLabel={`Seleccionar color ${playerColor}`}
              onPress={() => setColor(playerColor)}
              style={[
                styles.colorButton,
                { backgroundColor: playerColor },
                color === playerColor && styles.colorButtonSelected,
              ]}
            >
              {color === playerColor && <Text style={styles.check}>✓</Text>}
            </Pressable>
          ))}
        </View>
        )}

        <Text style={styles.label}>Identificador permanente</Text>
        <Text selectable style={styles.playerId}>{getActivePlayerId(profile)}</Text>
        <Text style={styles.identifierHelp}>
          Este identificador conserva la propiedad de tus territorios y no cambia al editar el perfil.
        </Text>

        <Pressable
          disabled={saving}
          onPress={() => void save()}
          style={({ pressed }) => [
            styles.saveButton,
            pressed && styles.pressed,
            saving && styles.disabled,
          ]}
        >
          {saving ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.saveButtonText}>Guardar perfil</Text>
          )}
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Cuenta PaintFoot.io</Text>
        <View style={styles.coinBalanceCard}>
          <Text style={styles.coinBalanceIcon}>🪙</Text>
          <View>
            <Text style={styles.coinBalanceTitle}>Monedas disponibles</Text>
            <Text style={styles.coinBalanceValue}>{coinBalance}</Text>
          </View>
        </View>
        {authSession?.user ? (
          <>
            <Text style={styles.label}>Nombre</Text>
            <Text style={styles.accountValue}>
              {authSession.user.name || "No disponible"}
            </Text>
            <Text style={styles.label}>Edad</Text>
            <Text style={styles.accountValue}>
              {authSession.user.age ? `${authSession.user.age} años` : "No disponible"}
            </Text>
            <Text style={styles.label}>Correo electrónico</Text>
            <Text style={styles.accountEmail}>{authSession.user.email}</Text>
            <Text style={styles.storageHelp}>
              Tu sesión permanece guardada para que PaintFoot.io pueda abrir sin conexión.
            </Text>
            <Pressable
              disabled={accountBusy}
              onPress={() => void logout()}
              style={({ pressed }) => [
                styles.cacheButton,
                pressed && styles.pressed,
                accountBusy && styles.disabled,
              ]}
            >
              <Text style={styles.cacheButtonText}>Cerrar sesión</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.storageHelp}>
              Inicia sesión una vez con Internet para respaldar y recuperar tu progreso.
            </Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="Correo electrónico"
              placeholderTextColor="#6F7897"
              style={styles.input}
            />
            <TextInput
              value={password}
              onChangeText={setPassword}
              autoCapitalize="none"
              secureTextEntry
              placeholder="Contraseña"
              placeholderTextColor="#6F7897"
              style={styles.input}
            />
            <View style={styles.accountActions}>
              <Pressable
                disabled={accountBusy}
                onPress={() => void authenticate("login")}
                style={({ pressed }) => [styles.accountButton, pressed && styles.pressed, accountBusy && styles.disabled]}
              >
                <Text style={styles.saveButtonText}>Iniciar sesión</Text>
              </Pressable>
              <Pressable
                disabled={accountBusy}
                onPress={() => void authenticate("register")}
                style={({ pressed }) => [styles.accountButtonSecondary, pressed && styles.pressed, accountBusy && styles.disabled]}
              >
                <Text style={styles.cacheButtonText}>Crear cuenta</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Configuracion del juego</Text>
        <Text style={styles.label}>Tema</Text>
        <View style={[styles.choiceRow, compactLayout && styles.choiceRowCompact]}>
          {(["light", "dark", "auto"] as ThemePreference[]).map((preference) => (
            <Pressable
              key={preference}
              accessibilityRole="button"
              onPress={() => updateThemePreference(preference)}
              style={({ pressed }) => [
                styles.choiceButton,
                themePreference === preference && styles.choiceButtonActive,
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.choiceButtonText,
                  themePreference === preference && styles.choiceButtonTextActive,
                ]}
              >
                {preference === "light"
                  ? "Claro"
                  : preference === "dark"
                    ? "Oscuro"
                    : "Auto"}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.securitySection}>
          <Text style={styles.label}>Seguridad</Text>
          <View style={styles.settingRow}>
            <View style={styles.settingTextWrap}>
              <Text style={styles.settingLabel}>
                Confirmar compras con huella o rostro
              </Text>
              <Text style={styles.identifierHelp}>
                {biometricSettings?.available
                  ? biometricSettings.enabled
                    ? "Activado para compras de escudos"
                    : "Desactivado"
                  : "No disponible en este dispositivo"}
              </Text>
            </View>
            <Switch
              accessibilityLabel="Confirmar compras con huella o rostro"
              disabled={!biometricSettings?.available}
              value={biometricSettings?.enabled ?? false}
              onValueChange={(value) => void updateBiometricPurchasePreference(value)}
              trackColor={{ false: "#48506A", true: "#315E9E" }}
              thumbColor={biometricSettings?.enabled ? "#40C4FF" : "#B0B7CA"}
            />
          </View>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Estado del sistema</Text>
        <View style={styles.systemRows}>
          <View style={styles.systemRow}>
            <Text style={styles.systemLabel}>GPS</Text>
            <Text style={styles.systemValue}>{gpsStatus}</Text>
          </View>
          <View style={styles.systemRow}>
            <Text style={styles.systemLabel}>Segundo plano</Text>
            <Text style={styles.systemValue}>
              {backgroundStatusText(systemStatus.backgroundTracking)}
            </Text>
          </View>
          <View style={styles.systemRow}>
            <Text style={styles.systemLabel}>Notificaciones</Text>
            <Text style={styles.systemValue}>{pushStatusText(systemStatus.push)}</Text>
          </View>
          {systemStatus.push === "permission-denied" && (
            <Pressable
              onPress={openGameNotificationSettings}
              style={({ pressed }) => [styles.smallAction, pressed && styles.pressed]}
            >
              <Text style={styles.smallActionText}>Abrir ajustes</Text>
            </Pressable>
          )}
          <View style={styles.systemRow}>
            <Text style={styles.systemLabel}>Mapa global</Text>
            <Text style={styles.systemValue}>
              {worldStatusText(systemStatus.world, systemStatus.online)}
            </Text>
          </View>
          <View style={styles.systemRow}>
            <Text style={styles.systemLabel}>Calles guardadas</Text>
            <Text style={styles.systemValue}>
              {systemStatus.roadsUsingCache
                ? "Usando calles guardadas"
                : roadStatusText(systemStatus.roads)}
            </Text>
          </View>
          {systemStatus.roads === "pending" && (
            <Pressable
              onPress={retryRoadMatching}
              style={({ pressed }) => [styles.smallAction, pressed && styles.pressed]}
            >
              <Text style={styles.smallActionText}>Reintentar validacion</Text>
            </Pressable>
          )}
          <View style={styles.systemRow}>
            <Text style={styles.systemLabel}>Sensores</Text>
            <Text style={styles.systemValue}>
              {activeSensorCount > 0
                ? `${activeSensorCount} activos · ${availableSensorCount}/${sensorStates.length} disponibles`
                : `${availableSensorCount}/${sensorStates.length} disponibles`}
            </Text>
          </View>
          <View style={styles.systemRow}>
            <Text style={styles.systemLabel}>Cache regional</Text>
            <Text style={styles.systemValue}>
              {storageStats ? formatStorageSize(storageStats.roadCacheSize) : "Calculando"}
            </Text>
          </View>
          <View style={styles.systemRow}>
            <Text style={styles.systemLabel}>Sincronizacion</Text>
            <Text style={styles.systemValue}>
              {storageStats && storageStats.pendingSyncCount > 0
                ? `${storageStats.pendingSyncCount} pendientes`
                : systemStatus.pendingValidation
                  ? "Validacion pendiente"
                  : "Al dia"}
            </Text>
          </View>
          <View style={styles.systemRow}>
            <Text style={styles.systemLabel}>Modo offline</Text>
            <Text style={styles.systemValue}>
              {systemStatus.online ? "Inactivo" : "Activo · guardando local"}
            </Text>
          </View>
          {OFFLINE_SIMULATION_ENABLED && (
            <Pressable
              accessibilityRole="button"
              onPress={() => setSimulationVisible(true)}
              style={({ pressed }) => [styles.simulationButton, pressed && styles.pressed]}
            >
              <View style={styles.simulationButtonTextWrap}>
                <Text style={styles.simulationButtonTitle}>Simulacion offline</Text>
                <Text style={styles.simulationButtonHelp}>
                  Probar GPS, SQLite, hash y sincronizacion sin afectar tu partida
                </Text>
              </View>
              <Text style={styles.simulationButtonArrow}>›</Text>
            </Pressable>
          )}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Multijugador global</Text>
        {([
          ["showNearbyPlayers", "Ver jugadores cercanos"],
          ["shareRealtimeLocation", "Compartir mi ubicaciÃ³n en tiempo real"],
          ["showPlayerNames", "Mostrar nombres en el mapa"],
          ["showOtherTerritories", "Mostrar territorios de otros jugadores"],
          ["showProtectedTerritories", "Mostrar territorios protegidos"],
          ["showDisputedTerritories", "Mostrar disputas"],
        ] as Array<[keyof MultiplayerPreferences, string]>).map(([key, label]) => (
          <View key={key} style={styles.settingRow}>
            <Text style={styles.settingLabel}>{label}</Text>
            <Switch
              value={multiplayerPreferences[key]}
              onValueChange={(value) => updateMultiplayerPreference(key, value)}
              trackColor={{ false: "#48506A", true: "#315E9E" }}
              thumbColor={multiplayerPreferences[key] ? "#40C4FF" : "#B0B7CA"}
            />
          </View>
        ))}
        <Text style={styles.storageHelp}>
          Si desactivas compartir ubicaciÃ³n, puedes seguir jugando y viendo territorios globales.
        </Text>
      </View>

      <View style={[styles.statsGrid, compactLayout && styles.statsGridCompact]}>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{territories.length}</Text>
          <Text style={styles.statLabel}>Territorios</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>
            {Math.round(statistics.areaM2).toLocaleString()}
          </Text>
          <Text style={styles.statLabel}>Área total m²</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{statistics.protectedTerritories}</Text>
          <Text style={styles.statLabel}>Protegidos</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Último recorrido</Text>
        {latestSession ? (
          <View style={styles.sessionDetails}>
            <Text style={styles.sessionText}>
              Distancia: {Math.round(latestSession.distanceMeters).toLocaleString()} m
            </Text>
            <Text style={styles.sessionText}>
              Duración: {formatDuration(latestSession.durationMs)}
            </Text>
            <Text style={styles.sessionText}>
              Pasos: {latestSession.steps?.toLocaleString() ?? "No disponibles"}
            </Text>
            <Text style={styles.sessionText}>
              Territorios conquistados: {latestSession.territoriesCaptured}
            </Text>
            <Text style={styles.sessionText}>
              Área conquistada: {Math.round(latestSession.areaCapturedM2).toLocaleString()} m²
            </Text>
          </View>
        ) : (
          <Text style={styles.emptyText}>
            Completa tu primer recorrido para ver estadísticas aquí.
          </Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Almacenamiento</Text>
        {storageStats ? (
          <View style={styles.storageRows}>
            <View style={styles.storageRow}>
              <Text style={styles.storageLabel}>Datos de PaintFoot.io</Text>
              <Text style={styles.storageValue}>
                {formatStorageSize(storageStats.totalSize)}
              </Text>
            </View>
            <View style={styles.storageRow}>
              <Text style={styles.storageLabel}>Territorios</Text>
              <Text style={styles.storageValue}>
                {formatStorageSize(storageStats.territoriesSize)}
              </Text>
            </View>
            <View style={styles.storageRow}>
              <Text style={styles.storageLabel}>Recorridos</Text>
              <Text style={styles.storageValue}>
                {formatStorageSize(storageStats.tracksSize)}
              </Text>
            </View>
            <View style={styles.storageRow}>
              <Text style={styles.storageLabel}>Mapas y calles</Text>
              <Text style={styles.storageValue}>
                {formatStorageSize(storageStats.roadCacheSize)}
              </Text>
            </View>
            <View style={styles.storageRow}>
              <Text style={styles.storageLabel}>Zonas disponibles offline</Text>
              <Text style={styles.storageValue}>{storageStats.roadCacheRegionCount}</Text>
            </View>
            <Text style={styles.storageHelp}>
              {storageStats.pendingSyncCount > 0
                ? `${storageStats.pendingSyncCount} operaciones esperan respaldo seguro.`
                : "Los datos locales importantes están al día."}
            </Text>
            <Pressable
              disabled={clearingCache}
              onPress={clearCache}
              style={({ pressed }) => [
                styles.cacheButton,
                pressed && styles.pressed,
                clearingCache && styles.disabled,
              ]}
            >
              {clearingCache ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.cacheButtonText}>Limpiar caché</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <Text style={styles.emptyText}>Calculando espacio utilizado...</Text>
        )}
      </View>

      <Text style={styles.localNotice}>
        El perfil se guarda en este dispositivo. No contiene información de pago ni datos de tarjeta.
      </Text>
    </ScrollView>
    {OFFLINE_SIMULATION_ENABLED && (
      <OfflineSimulationScreen
        visible={simulationVisible}
        onClose={() => setSimulationVisible(false)}
        playerColor={color}
      />
    )}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101426" },
  content: { width: "100%", maxWidth: 720, alignSelf: "center", paddingHorizontal: 16, gap: 18 },
  loadingScreen: { flex: 1, backgroundColor: "#101426", alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { color: "#C5CAE9", fontSize: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 14 },
  headerCompact: { alignItems: "flex-start", flexDirection: "column" },
  avatar: { width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: "#FFFFFF" },
  avatarText: { color: "#FFFFFF", fontSize: 30, fontWeight: "900" },
  headerText: { flex: 1 },
  title: { color: "#FFFFFF", fontSize: 25, fontWeight: "900" },
  subtitle: { color: "#AAB2CF", fontSize: 13, marginTop: 4 },
  card: { backgroundColor: "#1A1A2E", borderRadius: 18, padding: 16, gap: 10 },
  cardTitle: { color: "#FFFFFF", fontSize: 18, fontWeight: "900", marginBottom: 2 },
  label: { color: "#C5CAE9", fontSize: 12, fontWeight: "800", marginTop: 4 },
  input: { color: "#FFFFFF", backgroundColor: "#252C4D", borderRadius: 12, borderWidth: 1, borderColor: "#39436B", fontSize: 16, paddingHorizontal: 13, paddingVertical: 12 },
  colorRow: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingVertical: 3 },
  colorButton: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  colorButtonSelected: { borderWidth: 3, borderColor: "#FFFFFF" },
  check: { color: "#FFFFFF", fontSize: 20, fontWeight: "900" },
  playerId: { color: "#80CBC4", backgroundColor: "#11182C", borderRadius: 9, padding: 10, fontFamily: "monospace", fontSize: 12 },
  identifierHelp: { color: "#858FAC", fontSize: 11, lineHeight: 16 },
  saveButton: { minHeight: 48, backgroundColor: "#3949AB", borderRadius: 13, alignItems: "center", justifyContent: "center", marginTop: 4 },
  saveButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.55 },
  statsGrid: { flexDirection: "row", gap: 10 },
  statsGridCompact: { flexDirection: "column" },
  statCard: { flex: 1, minHeight: 96, minWidth: 0, backgroundColor: "#1A1A2E", borderRadius: 16, alignItems: "center", justifyContent: "center", padding: 10 },
  statValue: { color: "#72E6BE", fontSize: 20, fontWeight: "900" },
  statLabel: { color: "#AAB2CF", fontSize: 11, textAlign: "center", marginTop: 5 },
  sessionDetails: { gap: 8 },
  sessionText: { color: "#D6DAEA", fontSize: 13 },
  emptyText: { color: "#929BB8", fontSize: 13, lineHeight: 19 },
  storageRows: { gap: 10 },
  storageRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  storageLabel: { color: "#C5CAE9", fontSize: 13, flex: 1 },
  storageValue: { color: "#72E6BE", fontSize: 13, fontWeight: "800" },
  storageHelp: { color: "#858FAC", fontSize: 11, lineHeight: 16, marginTop: 2 },
  cacheButton: { minHeight: 44, backgroundColor: "#33405F", borderRadius: 12, alignItems: "center", justifyContent: "center", marginTop: 4 },
  cacheButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "900" },
  localNotice: { color: "#707A99", fontSize: 11, lineHeight: 17, textAlign: "center", paddingHorizontal: 18 },
  accountEmail: { color: "#72E6BE", fontSize: 15, fontWeight: "800" },
  accountValue: { color: "#F1F5FF", fontSize: 16, fontWeight: "800", marginBottom: 8 },
  coinBalance: { color: "#FFD54A", fontSize: 15, fontWeight: "900", marginLeft: "auto" },
  coinBalanceCard: { alignItems: "center", backgroundColor: "#1A2940", borderRadius: 16, flexDirection: "row", gap: 12, marginBottom: 16, padding: 14 },
  coinBalanceIcon: { fontSize: 28 },
  coinBalanceTitle: { color: "#AAB9D3", fontSize: 12, fontWeight: "700" },
  coinBalanceValue: { color: "#FFD54A", fontSize: 24, fontWeight: "900", marginTop: 2 },
  accountActions: { gap: 9, marginTop: 4 },
  accountButton: { minHeight: 48, backgroundColor: "#3949AB", borderRadius: 13, alignItems: "center", justifyContent: "center" },
  accountButtonSecondary: { minHeight: 46, backgroundColor: "#33405F", borderRadius: 13, alignItems: "center", justifyContent: "center" },
  globalColorRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  settingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 14, minHeight: 44 },
  settingLabel: { color: "#D6DAEA", fontSize: 13, flex: 1 },
  settingTextWrap: { flex: 1, gap: 3 },
  securitySection: { gap: 8, marginTop: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#303957" },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 9 },
  choiceRowCompact: { flexDirection: "column" },
  choiceButton: { flex: 1, minWidth: 88, minHeight: 42, borderRadius: 11, backgroundColor: "#252C4D", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#39436B" },
  choiceButtonActive: { backgroundColor: "#3949AB", borderColor: "#72B8FF" },
  choiceButtonText: { color: "#AAB2CF", fontSize: 13, fontWeight: "800" },
  choiceButtonTextActive: { color: "#FFFFFF" },
  systemRows: { gap: 12 },
  systemRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 16 },
  systemLabel: { color: "#C5CAE9", fontSize: 13, flex: 1 },
  systemValue: { color: "#72E6BE", fontSize: 13, fontWeight: "800", flex: 1.4, flexShrink: 1, textAlign: "right" },
  smallAction: { alignSelf: "flex-end", minHeight: 36, justifyContent: "center", backgroundColor: "#33405F", borderRadius: 10, paddingHorizontal: 12 },
  smallActionText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
  simulationButton: { minHeight: 64, marginTop: 4, paddingHorizontal: 13, paddingVertical: 11, borderRadius: 13, borderWidth: 1, borderColor: "#3D5682", backgroundColor: "#202D4B", flexDirection: "row", alignItems: "center", gap: 10 },
  simulationButtonTextWrap: { flex: 1, gap: 3 },
  simulationButtonTitle: { color: "#FFFFFF", fontSize: 14, fontWeight: "900" },
  simulationButtonHelp: { color: "#9DA8C6", fontSize: 10, lineHeight: 15 },
  simulationButtonArrow: { color: "#72B8FF", fontSize: 28, fontWeight: "500" },
});
