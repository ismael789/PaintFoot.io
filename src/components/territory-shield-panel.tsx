import * as WebBrowser from "expo-web-browser";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { scheduleShieldNotifications } from "@/services/push-notifications";
import {
  getShieldPurchaseHistory,
  saveShieldPurchaseRecord,
  subscribeToShieldPurchaseHistory,
  type ShieldPurchaseRecord,
} from "@/services/shield-purchase-history";
import {
  activatePurchasedTerritoryShield,
  claimFreeTerritoryShield,
  confirmShieldCheckout,
  createShieldCheckout,
  getPlayerShieldServerStatus,
  getShieldProducts,
  getShieldServerStatus,
  getStripeCheckoutSession,
  type PurchasedShield,
  type ShieldProduct,
} from "@/services/stripe-api";
import {
  canApplyShieldDuration,
  canPlayerActivateShield,
  formatShieldRemainingTime,
  getShieldRemainingMs,
  getPlayerShieldIndicator,
  shouldOpenShieldOptions,
} from "@/services/territory-shields";
import type { Territory, TerritoryShield } from "@/types/game";
import { showFeedback } from "@/services/global-feedback";
import { authenticateShieldPurchase } from "@/services/biometric-auth";
import {
  getGameSystemStatus,
  subscribeToGameSystemStatus,
} from "@/services/game-system-status";

const SHIELD_ASSETS = {
  available: require("../../escudo-territorio-activado al 100%.gif"),
  active: require("../../escudo-territorio-activado al 100%.gif"),
  warning: require("../../escudo-territorio-agotandose segunda parte.png"),
  exhausted: require("../../escudo-territorio-agotado 3er parte.png"),
} as const;

const SHIELD_STATE_GUIDE = [
  {
    id: "active",
    label: "Activo 100%",
    source: require("../../escudo-territorio-activado al 100%.gif"),
  },
  {
    id: "depleting",
    label: "Agotándose",
    source: require("../../escudo-territorio-agotandose primera parte.gif"),
  },
  {
    id: "last-stage",
    label: "Última etapa",
    source: require("../../escudo-territorio-agotandose segunda parte.png"),
  },
  {
    id: "exhausted",
    label: "Agotado",
    source: require("../../escudo-territorio-agotado 3er parte.png"),
  },
] as const;

const PURCHASE_STATUS_LABELS = {
  pending: "Pago pendiente",
  approved: "Pago aprobado",
  rejected: "Pago rechazado",
  canceled: "Pago cancelado",
} as const;

const PROTECTION_ACTION_COLOR = "#635BFF";
const DEFAULT_SHIELD_PRODUCTS: ShieldProduct[] = ([1, 6, 12, 24, 36] as const).map(
  (durationHours) => ({
    id: `shield_${durationHours}h`,
    duration_hours: durationHours,
    configured: false,
  }),
);

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatPrice(product: ShieldProduct) {
  if (product.unit_amount == null || !product.currency) {
    return "Ver precio al continuar";
  }
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: product.currency.toUpperCase(),
  }).format(product.unit_amount / 100);
}

interface Props {
  territories: Territory[];
  playerId: string;
  onShieldUpdated: (territoryId: string, shield: TerritoryShield | null) => void;
  displayMode?: "map" | "payments";
}

export function TerritoryShieldPanel({
  territories,
  playerId,
  onShieldUpdated,
  displayMode = "map",
}: Props) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height, fontScale } = useWindowDimensions();
  const compactLayout = width < 390 || fontScale > 1.15;
  const modalMaxHeight = Math.max(180, height - insets.top - insets.bottom - 24);
  const colorScheme = useColorScheme();
  const systemStatus = useSyncExternalStore(
    subscribeToGameSystemStatus,
    getGameSystemStatus,
    getGameSystemStatus,
  );
  const lightTheme = colorScheme === "light";
  const ownedTerritories = useMemo(
    () => territories.filter((territory) => territory.playerId === playerId),
    [playerId, territories],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [optionsVisible, setOptionsVisible] = useState(false);
  const [mapMenuVisible, setMapMenuVisible] = useState(false);
  const [shieldStatesVisible, setShieldStatesVisible] = useState(false);
  const [inventoryVisible, setInventoryVisible] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [products, setProducts] = useState<ShieldProduct[]>(DEFAULT_SHIELD_PRODUCTS);
  const [purchasedShields, setPurchasedShields] = useState<PurchasedShield[]>([]);
  const [freeAvailableAt, setFreeAvailableAt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [history, setHistory] = useState<ShieldPurchaseRecord[]>([]);
  const expiredShieldRef = useRef<string | null>(null);
  const warningShieldRef = useRef<string | null>(null);
  const paymentInProgressRef = useRef(false);
  const setMessage = useCallback((nextMessage: string | null) => {
    if (!nextMessage) return;
    const normalized = nextMessage.toLowerCase();
    const isStoredPurchase = normalized.includes("comprado y guardado");
    const isSuccess = normalized.includes("activad") || isStoredPurchase;
    const isWarning =
      normalized.includes("necesitas conquistar") ||
      normalized.includes("lo sentimos") ||
      normalized.includes("36 horas");
    const displayMessage = normalized.includes("no se pudo completar el pago")
      ? "No se pudo completar el pago"
      : normalized.includes("necesitas conquistar") || normalized.includes("lo sentimos")
        ? "No tienes territorios para proteger"
        : nextMessage.replace(/\n[\s\S]*$/, "").replace(/\.$/, "");
    showFeedback({
      id: normalized.includes("pago") ? "payment-status" : "shield-status",
      type: isSuccess ? "success" : isWarning ? "warning" : "error",
      message: isSuccess
        ? isStoredPurchase
          ? "Escudo comprado y guardado"
          : normalized.includes("gratis")
          ? "Escudo activado"
          : "Protección activada"
        : displayMessage,
    });
  }, []);

  const selected = ownedTerritories.find((territory) => territory.id === selectedId)
    ?? ownedTerritories[0]
    ?? null;
  const canActivate = canPlayerActivateShield(territories, playerId);
  const indicator = useMemo(
    () => getPlayerShieldIndicator(territories, playerId, freeAvailableAt, now),
    [freeAvailableAt, now, playerId, territories],
  );
  const selectedRemainingMs = getShieldRemainingMs(selected?.shield, now);
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!playerId) return;
    let mounted = true;
    void getPlayerShieldServerStatus(playerId)
      .then((status) => {
        if (mounted) {
          setFreeAvailableAt(status.free_available_at);
          setPurchasedShields(status.purchased_shields ?? []);
        }
      })
      .catch(() => {
        // El indicador continúa disponible con el estado local si el servidor no responde.
      });
    return () => {
      mounted = false;
    };
  }, [playerId]);

  useEffect(() => {
    if (!playerId) return;
    let mounted = true;
    void getShieldPurchaseHistory(playerId).then((records) => {
      if (mounted) setHistory(records);
    });
    const unsubscribe = subscribeToShieldPurchaseHistory((records) => {
      if (mounted) {
        setHistory(records.filter((record) => record.playerId === playerId));
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [playerId]);

  useEffect(() => {
    if (!selected?.shield || selectedRemainingMs > 0) return;
    if (expiredShieldRef.current !== selected.id) {
      expiredShieldRef.current = selected.id;
      showFeedback({
        id: "shield-lifecycle",
        type: "warning",
        message: "Escudo agotado",
      });
    }
    onShieldUpdated(selected.id, null);
  }, [onShieldUpdated, selected, selectedRemainingMs]);

  useEffect(() => {
    if (indicator.state !== "warning" || !indicator.activeTerritory) return;
    if (warningShieldRef.current === indicator.activeTerritory.id) return;
    warningShieldRef.current = indicator.activeTerritory.id;
    showFeedback({
      id: "shield-lifecycle",
      type: "warning",
      message: "Escudo por expirar",
    });
  }, [indicator.activeTerritory, indicator.state]);

  const refreshOptions = useCallback(async () => {
    if (!playerId) return;
    setLoadingProducts(true);
    setMessage(null);
    try {
      const [nextProducts, playerStatus, territoryStatus] = await Promise.all([
        getShieldProducts(),
        getPlayerShieldServerStatus(playerId),
        selected
          ? getShieldServerStatus(selected.id, playerId)
          : Promise.resolve(null),
      ]);
      setProducts(nextProducts);
      setFreeAvailableAt(playerStatus.free_available_at);
      setPurchasedShields(playerStatus.purchased_shields ?? []);
      if (
        selected &&
        territoryStatus?.shield &&
        (selected.shield?.startedAt !== territoryStatus.shield.startedAt ||
          selected.shield?.expiresAt !== territoryStatus.shield.expiresAt ||
          selected.shield?.paymentId !== territoryStatus.shield.paymentId)
      ) {
        onShieldUpdated(selected.id, territoryStatus.shield);
      }
    } catch (error) {
      console.warn("[Protección] No se pudieron consultar las opciones:", error);
      setMessage("No pudimos cargar las opciones de protección. Intenta nuevamente.");
    } finally {
      setLoadingProducts(false);
    }
  }, [onShieldUpdated, playerId, selected]);

  const openOptions = useCallback(() => {
    setOptionsVisible(true);
    showFeedback({
      id: "shield-panel",
      type: "info",
      message: "Escudo abierto",
    });
    if (indicator.state === "available") {
      showFeedback({
        id: "shield-available",
        type: "info",
        message: "Escudo disponible",
      });
    }
    if (systemStatus.online) void refreshOptions();
  }, [indicator.state, refreshOptions, systemStatus.online]);

  const goToPayments = useCallback(() => {
    setOptionsVisible(false);
    showFeedback({
      id: "shield-navigation",
      type: "info",
      message: "Abriendo pagos",
    });
    router.navigate("/payments");
  }, [router]);

  useEffect(() => {
    if (displayMode === "payments") void refreshOptions();
  }, [displayMode, refreshOptions]);

  const applyShield = useCallback(
    (shield: TerritoryShield) => {
      if (!selected) return;
      onShieldUpdated(selected.id, shield);
      void scheduleShieldNotifications(selected.id, shield.startedAt, shield.expiresAt);
    },
    [onShieldUpdated, selected],
  );

  const claimFree = useCallback(async () => {
    if (!selected) {
      setMessage("Necesitas conquistar al menos un territorio para activar el escudo.");
      return;
    }
    setBusy("free");
    setMessage(null);
    try {
      const result = await claimFreeTerritoryShield(selected.id, playerId);
      setFreeAvailableAt(result.free_available_at);
      applyShield(result.shield);
      setMessage("Escudo gratis activado durante 1 hora.");
    } catch (error) {
      console.warn("[Protección] No se pudo activar el escudo gratis:", error);
      setMessage("No se pudo activar el escudo gratis");
    } finally {
      setBusy(null);
    }
  }, [applyShield, playerId, selected]);

  const activatePurchasedShield = useCallback(async (purchasedShield: PurchasedShield) => {
    if (!selected) {
      setMessage("El escudo está guardado. Conquista un territorio para poder activarlo.");
      return;
    }
    if (!canApplyShieldDuration(selected.shield, purchasedShield.durationHours, Date.now())) {
      setMessage("Tu protección total no puede superar 36 horas.");
      return;
    }
    setBusy(purchasedShield.id);
    try {
      const result = await activatePurchasedTerritoryShield(
        purchasedShield.id,
        selected.id,
        playerId,
      );
      applyShield(result.shield);
      setPurchasedShields((current) => current.filter((item) => item.id !== purchasedShield.id));
      showFeedback({
        id: "shield-inventory",
        type: "success",
        message: "Escudo comprado activado",
      });
    } catch (error) {
      console.warn("[Protección] No se pudo activar el escudo comprado:", error);
      setMessage("No se pudo activar el escudo comprado.");
    } finally {
      setBusy(null);
    }
  }, [applyShield, playerId, selected]);

  const payForShield = useCallback(
    (product: ShieldProduct) => {
      if (paymentInProgressRef.current || busy !== null) return;
      if (!systemStatus.online) {
        showFeedback({
          id: "shield-offline-purchase",
          type: "warning",
          message: "Necesitas conexión para comprar protección",
        });
        return;
      }
      if (selected && !canApplyShieldDuration(selected.shield, product.duration_hours, Date.now())) {
        setMessage("Tu protección total no puede superar 36 horas.");
        return;
      }
      const territoryId = selected?.id ?? null;
      paymentInProgressRef.current = true;
      Alert.alert(
        "Confirmar protección",
        territoryId
          ? `Territorio: ${territoryId}\nDuración: ${product.duration_hours} h\nPrecio: ${formatPrice(product)}\n\nLa protección comenzará después de confirmar el pago.`
          : `Duración: ${product.duration_hours} h\nPrecio: ${formatPrice(product)}\n\nEl escudo quedará guardado para activarlo cuando conquistes un territorio.`,
        [
          {
            text: "Cancelar",
            style: "cancel",
            onPress: () => {
              paymentInProgressRef.current = false;
            },
          },
          {
            text: "Continuar al pago",
            onPress: () => {
              void (async () => {
                setBusy(product.id);
                setMessage(null);
                showFeedback({
                  id: "payment-authentication",
                  type: "info",
                  message: "Confirma la compra",
                });
                const authentication = await authenticateShieldPurchase();
                if (!authentication.continueToPayment) {
                  showFeedback({
                    id: "payment-authentication",
                    type: "warning",
                    message: "Compra cancelada",
                  });
                  setBusy(null);
                  paymentInProgressRef.current = false;
                  return;
                }
                if (authentication.reason === "authenticated") {
                  showFeedback({
                    id: "payment-authentication",
                    type: "success",
                    message: "Identidad confirmada",
                  });
                } else if (authentication.reason === "unavailable") {
                  showFeedback({
                    id: "payment-authentication",
                    type: "warning",
                    message: "Confirmación biométrica no disponible",
                  });
                }
                const purchaseReference = `${playerId}_${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, "_");
                let purchaseRecord: ShieldPurchaseRecord = {
                  id: purchaseReference,
                  playerId,
                  territoryId,
                  productId: product.id,
                  durationHours: product.duration_hours,
                  amount: product.unit_amount ?? null,
                  currency: product.currency ?? null,
                  status: "pending",
                  createdAt: Date.now(),
                  stripeMode: "test",
                  sessionId: null,
                };
                let browserCanceled = false;
                try {
                  await saveShieldPurchaseRecord(purchaseRecord);
                  const session = await createShieldCheckout({
                    productId: product.id,
                    territoryId,
                    playerId,
                    purchaseReference,
                  });
                  purchaseRecord = {
                    ...purchaseRecord,
                    sessionId: session.session_id,
                  };
                  await saveShieldPurchaseRecord(purchaseRecord);
                  if (!session.url) throw new Error("No se pudo preparar la página de pago");
                  showFeedback({
                    id: "payment-status",
                    type: "info",
                    message: "Abriendo pago seguro",
                  });
                  const browserResult = await WebBrowser.openBrowserAsync(session.url, {
                    showTitle: true,
                    toolbarColor: "#101426",
                    controlsColor: "#FFFFFF",
                  });
                  browserCanceled =
                    browserResult.type === "cancel" ||
                    browserResult.type === "dismiss";

                  let verified = await getStripeCheckoutSession(session.session_id);
                  for (let attempt = 0; attempt < 4 && verified.payment_status !== "paid"; attempt += 1) {
                    await delay(1_500);
                    verified = await getStripeCheckoutSession(session.session_id);
                  }
                  if (verified.payment_status !== "paid" && verified.payment_status !== "no_payment_required") {
                    purchaseRecord = {
                      ...purchaseRecord,
                      status:
                        verified.status === "expired" || browserCanceled
                          ? "canceled"
                          : "pending",
                    };
                    await saveShieldPurchaseRecord(purchaseRecord);
                    showFeedback({
                      id: "payment-status",
                      type: browserCanceled ? "warning" : "error",
                      message: browserCanceled
                        ? "Pago cancelado"
                        : "No se pudo completar el pago",
                    });
                    return;
                  }
                  const confirmed = await confirmShieldCheckout(session.session_id, territoryId, playerId);
                  if (confirmed.shield && territoryId) {
                    applyShield(confirmed.shield);
                  }
                  if (confirmed.purchased_shield) {
                    setPurchasedShields((current) => [
                      ...current.filter((item) => item.id !== confirmed.purchased_shield!.id),
                      confirmed.purchased_shield!,
                    ]);
                  }
                  purchaseRecord = { ...purchaseRecord, status: "approved" };
                  await saveShieldPurchaseRecord(purchaseRecord);
                  showFeedback({
                    id: "payment-status",
                    type: "success",
                    message: "Pago aprobado",
                  });
                  setMessage(territoryId
                    ? `✓ Protección activada.\nTerritorio: ${territoryId}\nDuración: ${product.duration_hours} horas.`
                    : `✓ Escudo comprado y guardado.\nDuración: ${product.duration_hours} horas.`);
                } catch (error) {
                  await saveShieldPurchaseRecord({
                    ...purchaseRecord,
                    status: browserCanceled ? "canceled" : "rejected",
                  }).catch(() => undefined);
                  console.warn("[Protección] No se pudo completar el pago:", error);
                  setMessage("No se pudo completar el pago. No se realizó ningún cambio.");
                } finally {
                  setBusy(null);
                  paymentInProgressRef.current = false;
                }
              })();
            },
          },
        ],
      );
    },
    [applyShield, busy, playerId, selected, systemStatus.online],
  );

  const inventoryContent = purchasedShields.length === 0 ? (
    <View style={styles.noTerritoryCard}>
      <Text style={styles.noTerritoryTitle}>Inventario vacío</Text>
      <Text style={styles.noTerritoryText}>
        Los escudos que compres sin territorio aparecerán aquí hasta que decidas activarlos.
      </Text>
    </View>
  ) : (
    <View style={styles.inventoryList}>
      {purchasedShields.map((purchasedShield) => (
        <View
          key={purchasedShield.id}
          style={[styles.purchasedShieldCard, compactLayout && styles.stackedCard]}
        >
          <View style={styles.purchasedShieldText}>
            <Text style={styles.productHours}>Escudo {purchasedShield.durationHours} horas</Text>
            <Text style={styles.productProvider}>
              {selected ? `Listo para ${selected.id}` : "Guardado hasta conquistar un territorio"}
            </Text>
          </View>
          <Pressable
            disabled={!selected || busy !== null}
            onPress={() => void activatePurchasedShield(purchasedShield)}
            style={[styles.productActionButton, (!selected || busy !== null) && styles.disabled]}
            accessibilityRole="button"
          >
            {busy === purchasedShield.id
              ? <ActivityIndicator color="#FFFFFF" />
              : <Text style={styles.productActionText}>
                  {selected ? "ACTIVAR" : "GUARDADO"}
                </Text>}
          </Pressable>
        </View>
      ))}
    </View>
  );

  const historyContent = history.length === 0 ? (
    <Text style={styles.mutedHistory}>Todavía no hay compras de protección.</Text>
  ) : (
    <View style={styles.historySection}>
      {history.map((record) => (
        <View key={record.id} style={styles.historyCard}>
          <Text style={styles.historyTitle}>Protección de territorio · {record.durationHours} h</Text>
          <Text style={styles.historyDetail}>
            Territorio: {record.territoryId ?? "Pendiente de asignar"}
          </Text>
          <Text style={styles.historyDetail}>Estado: {PURCHASE_STATUS_LABELS[record.status]}</Text>
          <Text style={styles.historyDetail}>Fecha: {new Date(record.createdAt).toLocaleString("es-MX")}</Text>
          <Text style={styles.historyDetail}>
            Importe: {record.amount == null || !record.currency
              ? "Importe no disponible"
              : new Intl.NumberFormat("es-MX", { style: "currency", currency: record.currency.toUpperCase() }).format(record.amount / 100)}
          </Text>
          <Text style={styles.historyMode}>MODO DE PRUEBAS</Text>
        </View>
      ))}
    </View>
  );

  const optionsContent = (
    <>
      {displayMode === "payments" && (
        <View
          style={[
            styles.currentProtectionCard,
            compactLayout && styles.currentProtectionCardCompact,
          ]}
        >
          <Image
            source={SHIELD_ASSETS[indicator.state]}
            style={styles.currentProtectionImage}
            contentFit="contain"
            autoplay
          />
          <View style={styles.currentProtectionText}>
            <Text style={styles.currentProtectionTitle}>
              {indicator.activeTerritory
                ? indicator.state === "warning"
                  ? "Escudo agotándose"
                  : "Escudo activo"
                : "Sin protección activa"}
            </Text>
            {indicator.activeTerritory ? (
              <>
                <Text style={styles.currentProtectionDetail}>
                  Territorio protegido: {indicator.activeTerritory.id}
                </Text>
                <Text style={styles.currentProtectionDetail}>
                  Protección restante: {formatShieldRemainingTime(indicator.remainingMs)}
                </Text>
                <Text style={styles.currentProtectionDetail}>
                  Expira: {new Date(indicator.activeTerritory.shield!.expiresAt).toLocaleString("es-MX")}
                </Text>
              </>
            ) : (
              <Text style={styles.currentProtectionDetail}>
                Puedes comprar protección ahora y activarla en un territorio propio.
              </Text>
            )}
          </View>
        </View>
      )}

      <Text style={styles.testMode}>MODO DE PRUEBAS</Text>
      <Text style={styles.sectionTitle}>Territorio propio</Text>
      {!canActivate ? (
        <View style={styles.noTerritoryCard}>
          <Text style={styles.noTerritoryTitle}>Territorios: 0</Text>
          <Text style={styles.noTerritoryText}>
            Puedes comprar escudos ahora. Quedarán guardados hasta que conquistes un territorio.
          </Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.territoryRow}>
          {ownedTerritories.map((territory, index) => (
            <Pressable
              key={territory.id}
              style={[styles.territoryChoice, territory.id === selected?.id && styles.selectedChoice]}
              onPress={() => { setSelectedId(territory.id); setMessage(null); }}
            >
              <Text style={styles.choiceText}>#{index + 1} · {Math.round(territory.areaM2).toLocaleString()} m²</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {purchasedShields.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Escudos comprados</Text>
          {inventoryContent}
        </>
      )}

      <Text style={styles.sectionTitle}>Escudo gratuito · no es una compra</Text>
      <Pressable
        disabled={busy !== null || now < freeAvailableAt}
        onPress={() => void claimFree()}
        style={[styles.freeButton, (busy !== null || now < freeAvailableAt) && styles.disabled]}
        accessibilityRole="button"
      >
        <Text style={styles.freeTitle}>ESCUDO GRATIS · 1 HORA</Text>
        <Text style={styles.freeSubtitle}>
          {now >= freeAvailableAt
            ? "Disponible ahora · uno cada 24 horas"
            : `Disponible en ${formatShieldRemainingTime(freeAvailableAt - now)}`}
        </Text>
        <Text style={[styles.protectionActionText, styles.freeActionText]}>
          {now >= freeAvailableAt ? "ACTIVAR GRATIS" : "NO DISPONIBLE"}
        </Text>
      </Pressable>

      <Text style={styles.sectionTitle}>Comprar protección manualmente</Text>
      <Text style={styles.maximumNotice}>Máximo de protección continua: 36 horas</Text>
      <Text style={styles.legal}>
        Las monedas no compran ni activan escudos por sí solas. Tú eliges el
        escudo, confirmas la compra y decides cuándo activarlo.
      </Text>
      <ScrollView style={styles.products} nestedScrollEnabled>
        {loadingProducts && <ActivityIndicator color="#4DD0E1" />}
        {products.map((product) => (
          <Pressable
            key={product.id}
            disabled={busy !== null}
            onPress={() => payForShield(product)}
            style={[
              styles.product,
              compactLayout && styles.productCompact,
              busy !== null && styles.disabled,
            ]}
            accessibilityRole="button"
          >
            <View>
              <Text style={styles.productHours}>Escudo {product.duration_hours} horas</Text>
              <Text style={styles.productProvider}>Pago seguro</Text>
            </View>
            <View
              style={[
                styles.productActionColumn,
                compactLayout && styles.productActionColumnCompact,
              ]}
            >
              <Text style={product.unit_amount == null ? styles.notConfigured : styles.productPrice}>{formatPrice(product)}</Text>
              <View style={styles.productActionButton}>
                {busy === product.id
                  ? <ActivityIndicator color="#FFFFFF" />
                  : <Text style={styles.productActionText}>
                      COMPRAR
                    </Text>}
              </View>
            </View>
          </Pressable>
        ))}
      </ScrollView>
      <Text style={styles.legal}>
        {selected
          ? "La protección comenzará después de confirmar el pago."
          : "La compra quedará guardada y no comenzará hasta que la actives en un territorio propio."}
      </Text>

    </>
  );

  if (displayMode === "payments") {
    return (
      <View style={styles.inlinePanel}>
        <Text style={styles.inlineTitle}>Protección de territorios</Text>
        {optionsContent}
      </View>
    );
  }

  return (
    <>
      <Pressable
        style={[
          styles.mapMenuButton,
          {
            top: Math.max(104, insets.top + 78),
            backgroundColor: lightTheme
              ? "rgba(255,255,255,0.94)"
              : "rgba(10,18,42,0.94)",
          },
        ]}
        onPress={() => setMapMenuVisible(true)}
        accessibilityRole="button"
        accessibilityLabel="Abrir menú del mapa"
      >
        <View style={styles.hamburgerIcon}>
          <View style={[styles.hamburgerLine, lightTheme && styles.hamburgerLineLight]} />
          <View style={[styles.hamburgerLine, lightTheme && styles.hamburgerLineLight]} />
          <View style={[styles.hamburgerLine, lightTheme && styles.hamburgerLineLight]} />
        </View>
      </Pressable>

      <Pressable
        style={[styles.mapBadge, { top: Math.max(84, insets.top + 54) }]}
        onPress={shouldOpenShieldOptions(indicator.state) ? openOptions : undefined}
        accessibilityRole="button"
      >
        <Image
          source={SHIELD_ASSETS[indicator.state]}
          style={styles.badgeImage}
          contentFit="contain"
          autoplay
        />
      </Pressable>

      <Modal
        visible={mapMenuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMapMenuVisible(false)}
      >
        <Pressable
          style={[
            styles.mapMenuBackdrop,
            {
              paddingTop: Math.max(130, insets.top + 96),
              paddingBottom: Math.max(12, insets.bottom + 8),
            },
          ]}
          onPress={() => setMapMenuVisible(false)}
        >
          <ScrollView
            style={[
              styles.mapMenuCard,
              lightTheme && styles.mapMenuCardLight,
              {
                width: Math.min(300, width - 32),
                maxHeight: Math.max(160, height - insets.top - insets.bottom - 130),
              },
            ]}
            contentContainerStyle={styles.mapMenuCardContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.mapMenuHeader}>
              <Text style={[styles.mapMenuTitle, lightTheme && styles.mapMenuTextLight]}>MENÚ</Text>
              <Pressable
                onPress={() => setMapMenuVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Cerrar menú"
              >
                <Text style={styles.mapMenuClose}>Cerrar</Text>
              </Pressable>
            </View>
            <Pressable
              style={[styles.mapMenuOption, lightTheme && styles.mapMenuOptionLight]}
              onPress={() => {
                setMapMenuVisible(false);
                setShieldStatesVisible(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Escudo"
            >
              <SymbolView
                name={{ ios: "shield.fill", android: "shield" }}
                size={34}
                tintColor={lightTheme ? "#17213B" : "#83DFFF"}
              />
              <Text style={[styles.mapMenuOptionTitle, lightTheme && styles.mapMenuTextLight]}>Escudo</Text>
            </Pressable>
            <Pressable
              style={[styles.mapMenuOption, lightTheme && styles.mapMenuOptionLight]}
              onPress={() => {
                setMapMenuVisible(false);
                openOptions();
              }}
              accessibilityRole="button"
              accessibilityLabel="Comprar escudos"
            >
              <SymbolView
                name={{ ios: "creditcard.fill", android: "payments" }}
                size={34}
                tintColor={lightTheme ? "#17213B" : "#83DFFF"}
              />
              <Text style={[styles.mapMenuOptionTitle, lightTheme && styles.mapMenuTextLight]}>
                Comprar escudos
              </Text>
            </Pressable>
            <Pressable
              style={[styles.mapMenuOption, lightTheme && styles.mapMenuOptionLight]}
              onPress={() => {
                setMapMenuVisible(false);
                setInventoryVisible(true);
                if (systemStatus.online) void refreshOptions();
              }}
              accessibilityRole="button"
              accessibilityLabel="Inventario de escudos"
            >
              <SymbolView
                name={{ ios: "shippingbox.fill", android: "inventory_2" }}
                size={34}
                tintColor={lightTheme ? "#17213B" : "#83DFFF"}
              />
              <Text style={[styles.mapMenuOptionTitle, lightTheme && styles.mapMenuTextLight]}>
                Inventario ({purchasedShields.length})
              </Text>
            </Pressable>
            <Pressable
              style={[styles.mapMenuOption, lightTheme && styles.mapMenuOptionLight]}
              onPress={() => {
                setMapMenuVisible(false);
                setHistoryVisible(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Historial de escudos comprados"
            >
              <SymbolView
                name={{ ios: "clock.arrow.circlepath", android: "history" }}
                size={34}
                tintColor={lightTheme ? "#17213B" : "#83DFFF"}
              />
              <Text style={[styles.mapMenuOptionTitle, lightTheme && styles.mapMenuTextLight]}>
                Historial
              </Text>
            </Pressable>
          </ScrollView>
        </Pressable>
      </Modal>

      <Modal
        visible={shieldStatesVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setShieldStatesVisible(false)}
      >
        <Pressable
          style={styles.shieldGuideBackdrop}
          onPress={() => setShieldStatesVisible(false)}
          accessibilityRole="button"
          accessibilityLabel="Cerrar estados del escudo tocando fuera"
        >
          <Pressable
            style={[
              styles.shieldGuideCard,
              lightTheme && styles.shieldGuideCardLight,
              { maxHeight: modalMaxHeight, paddingBottom: Math.max(18, insets.bottom + 12) },
            ]}
            onPress={(event) => event.stopPropagation()}
          >
            <View style={styles.modalHeader}>
              <Text style={[styles.shieldGuideTitle, lightTheme && styles.mapMenuTextLight]}>
                Estados del escudo
              </Text>
              <Pressable
                onPress={() => setShieldStatesVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Cerrar estados del escudo"
              >
                <Text style={styles.close}>Cerrar</Text>
              </Pressable>
            </View>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.shieldGuideContent}
            >
              <View style={styles.shieldGuideGrid}>
                {SHIELD_STATE_GUIDE.map((state) => (
                  <View
                    key={state.id}
                    style={[
                      styles.shieldGuideState,
                      compactLayout && styles.shieldGuideStateCompact,
                      lightTheme && styles.shieldGuideStateLight,
                    ]}
                  >
                    <View style={styles.shieldGuideImageFrame}>
                      <Image
                        source={state.source}
                        style={[
                          styles.shieldGuideImage,
                          state.id === "active" && styles.shieldGuideActiveImage,
                        ]}
                        contentFit="contain"
                        autoplay
                      />
                    </View>
                    <Text style={[styles.shieldGuideLabel, lightTheme && styles.mapMenuTextLight]}>
                      {state.label}
                    </Text>
                  </View>
                ))}
              </View>
              <Pressable
                style={styles.goToPaymentsButton}
                onPress={() => {
                  setShieldStatesVisible(false);
                  openOptions();
                }}
                accessibilityRole="button"
              >
                <Text style={styles.protectionActionText}>IR A PROTECCIÓN</Text>
              </Pressable>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={inventoryVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setInventoryVisible(false)}
      >
        <Pressable style={styles.shieldGuideBackdrop} onPress={() => setInventoryVisible(false)}>
          <Pressable
            style={[
              styles.shieldGuideCard,
              lightTheme && styles.shieldGuideCardLight,
              { maxHeight: modalMaxHeight, paddingBottom: Math.max(18, insets.bottom + 12) },
            ]}
            onPress={(event) => event.stopPropagation()}
          >
            <View style={styles.modalHeader}>
              <Text style={[styles.shieldGuideTitle, lightTheme && styles.mapMenuTextLight]}>
                Inventario de escudos
              </Text>
              <Pressable onPress={() => setInventoryVisible(false)} accessibilityRole="button">
                <Text style={styles.close}>Cerrar</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.shieldGuideContent}>
              {inventoryContent}
              <Pressable
                style={styles.goToPaymentsButton}
                onPress={() => {
                  setInventoryVisible(false);
                  openOptions();
                }}
                accessibilityRole="button"
              >
                <Text style={styles.protectionActionText}>COMPRAR ESCUDOS</Text>
              </Pressable>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={historyVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setHistoryVisible(false)}
      >
        <Pressable style={styles.shieldGuideBackdrop} onPress={() => setHistoryVisible(false)}>
          <Pressable
            style={[
              styles.shieldGuideCard,
              lightTheme && styles.shieldGuideCardLight,
              { maxHeight: modalMaxHeight, paddingBottom: Math.max(18, insets.bottom + 12) },
            ]}
            onPress={(event) => event.stopPropagation()}
          >
            <View style={styles.modalHeader}>
              <Text style={[styles.shieldGuideTitle, lightTheme && styles.mapMenuTextLight]}>
                Historial de escudos
              </Text>
              <Pressable onPress={() => setHistoryVisible(false)} accessibilityRole="button">
                <Text style={styles.close}>Cerrar</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.shieldGuideContent}>
              {historyContent}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={optionsVisible} transparent animationType="slide" onRequestClose={() => setOptionsVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View
            style={[
              styles.modalCard,
              { maxHeight: modalMaxHeight, paddingBottom: Math.max(18, insets.bottom + 12) },
            ]}
          >
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>ESCUDOS</Text>
              <Pressable onPress={() => setOptionsVisible(false)}><Text style={styles.close}>Cerrar</Text></Pressable>
            </View>
            <Pressable
              style={styles.goToPaymentsButton}
              onPress={goToPayments}
              accessibilityRole="button"
            >
              <Text style={styles.protectionActionText}>IR A PAGOS</Text>
            </Pressable>
            <ScrollView
              nestedScrollEnabled
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.optionsScrollContent}
            >
              {optionsContent}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  inlinePanel: { backgroundColor: "#1A1A2E", borderRadius: 18, padding: 16, gap: 12 },
  inlineTitle: { color: "#FFFFFF", fontSize: 20, fontWeight: "900" },
  currentProtectionCard: { backgroundColor: "#202744", borderRadius: 15, padding: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  currentProtectionCardCompact: { alignItems: "flex-start", flexDirection: "column" },
  currentProtectionImage: { width: 72, height: 72 },
  currentProtectionText: { flex: 1, gap: 3 },
  currentProtectionTitle: { color: "#FFFFFF", fontSize: 16, fontWeight: "900" },
  currentProtectionDetail: { color: "#C5CAE9", fontSize: 11, lineHeight: 16 },
  mapBadge: { position: "absolute", left: 0, width: 136, height: 136, alignItems: "center", justifyContent: "center" },
  badgeImage: { width: 128, height: 128 },
  mapMenuButton: { position: "absolute", right: 16, width: 52, height: 52, borderRadius: 16, alignItems: "center", justifyContent: "center", elevation: 9 },
  hamburgerIcon: { width: 24, gap: 5 },
  hamburgerLine: { width: 24, height: 3, borderRadius: 2, backgroundColor: "#FFFFFF" },
  hamburgerLineLight: { backgroundColor: "#17213B" },
  mapMenuBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.3)", alignItems: "flex-end", paddingRight: 16 },
  mapMenuCard: { borderRadius: 17, backgroundColor: "#151B31", borderWidth: 1, borderColor: "#35405F", elevation: 12 },
  mapMenuCardContent: { padding: 13, gap: 10 },
  mapMenuCardLight: { backgroundColor: "#FFFFFF", borderColor: "#C8D0E3" },
  mapMenuHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  mapMenuTitle: { color: "#AAB2CF", fontSize: 11, fontWeight: "900", letterSpacing: 1.2 },
  mapMenuClose: { color: "#208AEF", fontSize: 12, fontWeight: "900" },
  mapMenuOption: { minHeight: 72, borderRadius: 13, paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#222A48" },
  mapMenuOptionLight: { backgroundColor: "#EEF3FC" },
  mapMenuTextLight: { color: "#17213B" },
  mapMenuOptionTitle: { color: "#FFFFFF", fontSize: 16, fontWeight: "900", flex: 1 },
  shieldGuideBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.72)", justifyContent: "flex-end" },
  shieldGuideCard: { maxHeight: "88%", backgroundColor: "#101426", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 18, gap: 14 },
  shieldGuideCardLight: { backgroundColor: "#F7F9FE" },
  shieldGuideTitle: { color: "#FFFFFF", fontSize: 21, fontWeight: "900" },
  shieldGuideContent: { gap: 16, paddingBottom: 8 },
  shieldGuideGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  shieldGuideState: { width: "48%", minHeight: 182, borderRadius: 16, padding: 10, alignItems: "center", justifyContent: "center", gap: 4, backgroundColor: "#202744" },
  shieldGuideStateCompact: { width: "100%" },
  shieldGuideStateLight: { backgroundColor: "#E8EEF9" },
  shieldGuideImageFrame: { width: 140, height: 140, alignItems: "center", justifyContent: "flex-end" },
  shieldGuideImage: { width: 108, height: 108 },
  shieldGuideActiveImage: { width: 140, height: 140, transform: [{ translateY: 32 }] },
  shieldGuideLabel: { color: "#FFFFFF", fontSize: 13, fontWeight: "900", textAlign: "center" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.72)", justifyContent: "flex-end" },
  modalCard: { maxHeight: "88%", backgroundColor: "#101426", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 18, gap: 12 },
  optionsScrollContent: { gap: 12, paddingBottom: 4 },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalTitle: { color: "#FFFFFF", fontSize: 21, fontWeight: "900" },
  close: { color: "#83DFFF", fontSize: 14, fontWeight: "800" },
  testMode: { color: "#8993B2", fontSize: 9, fontWeight: "700", alignSelf: "flex-end" },
  sectionTitle: { color: "#C5CAE9", fontSize: 13, fontWeight: "800" },
  territoryRow: { gap: 8 },
  territoryChoice: { backgroundColor: "#242B4A", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  selectedChoice: { borderColor: "#3FD8FF", borderWidth: 2 },
  choiceText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
  noTerritoryCard: { backgroundColor: "#242B4A", borderRadius: 12, padding: 13 },
  noTerritoryTitle: { color: "#FFFFFF", fontSize: 14, fontWeight: "900" },
  noTerritoryText: { color: "#C5CAE9", fontSize: 12, lineHeight: 18, marginTop: 4 },
  purchasedShieldCard: { backgroundColor: "#252C4D", borderRadius: 13, padding: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  stackedCard: { alignItems: "stretch", flexDirection: "column" },
  purchasedShieldText: { flex: 1 },
  inventoryList: { gap: 9 },
  freeButton: { backgroundColor: PROTECTION_ACTION_COLOR, borderRadius: 14, padding: 14 },
  freeTitle: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" },
  freeSubtitle: { color: "#E8E7FF", fontSize: 12, marginTop: 4 },
  protectionActionText: { color: "#FFFFFF", fontSize: 12, fontWeight: "900", textAlign: "center" },
  freeActionText: { marginTop: 10 },
  goToPaymentsButton: { backgroundColor: PROTECTION_ACTION_COLOR, borderRadius: 12, minHeight: 46, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  maximumNotice: { color: "#AAB2CF", fontSize: 11, marginTop: -6 },
  products: { maxHeight: 260 },
  product: { backgroundColor: "#252C4D", borderRadius: 13, padding: 14, marginBottom: 9, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  productCompact: { alignItems: "stretch", gap: 10, flexDirection: "column" },
  productHours: { color: "#FFFFFF", fontSize: 16, fontWeight: "900" },
  productProvider: { color: "#8993B2", fontSize: 10, marginTop: 3 },
  productPrice: { color: "#72E6BE", fontSize: 16, fontWeight: "900" },
  notConfigured: { color: "#FFB4B4", fontSize: 11, fontWeight: "800" },
  productActionColumn: { alignItems: "flex-end", gap: 7, marginLeft: 10 },
  productActionColumnCompact: { width: "100%", alignItems: "stretch", marginLeft: 0 },
  productActionButton: { backgroundColor: PROTECTION_ACTION_COLOR, borderRadius: 9, minHeight: 34, minWidth: 132, alignItems: "center", justifyContent: "center", paddingHorizontal: 10 },
  productActionText: { color: "#FFFFFF", fontSize: 9, fontWeight: "900", textAlign: "center" },
  disabled: { opacity: 0.5 },
  legal: { color: "#7F89AA", fontSize: 10, lineHeight: 15, textAlign: "center" },
  historySection: { gap: 9, marginTop: 4 },
  historyCard: { backgroundColor: "#242B4A", borderRadius: 13, padding: 12, gap: 3 },
  historyTitle: { color: "#FFFFFF", fontSize: 13, fontWeight: "900" },
  historyDetail: { color: "#C5CAE9", fontSize: 11, lineHeight: 16 },
  historyMode: { color: "#FFCC80", fontSize: 10, fontWeight: "900", marginTop: 3 },
  mutedHistory: { color: "#8993B2", fontSize: 12 },
});
