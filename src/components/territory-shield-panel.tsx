import * as WebBrowser from "expo-web-browser";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { scheduleShieldNotifications } from "@/services/push-notifications";
import {
  getShieldPurchaseHistory,
  saveShieldPurchaseRecord,
  subscribeToShieldPurchaseHistory,
  type ShieldPurchaseRecord,
} from "@/services/shield-purchase-history";
import {
  claimFreeTerritoryShield,
  confirmShieldCheckout,
  createShieldCheckout,
  getPlayerShieldServerStatus,
  getShieldProducts,
  getShieldServerStatus,
  getStripeCheckoutSession,
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

const SHIELD_ASSETS = {
  available: require("../../escudo-territorio-protegido.png"),
  active: require("../../escudo-territorio-agotandose primera parte.gif"),
  warning: require("../../escudo-territorio-agotandose segunda parte.png"),
  exhausted: require("../../escudo-territorio-agotado 3er parte.png"),
} as const;

const PURCHASE_STATUS_LABELS = {
  pending: "Pago pendiente",
  approved: "Pago aprobado",
  rejected: "Pago rechazado",
  canceled: "Pago cancelado",
} as const;

const PROTECTION_ACTION_COLOR = "#635BFF";

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatPrice(product: ShieldProduct) {
  if (!product.configured || product.unit_amount == null || !product.currency) {
    return "No disponible temporalmente";
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
  const ownedTerritories = useMemo(
    () => territories.filter((territory) => territory.playerId === playerId),
    [playerId, territories],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [optionsVisible, setOptionsVisible] = useState(false);
  const [products, setProducts] = useState<ShieldProduct[]>([]);
  const [freeAvailableAt, setFreeAvailableAt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<ShieldPurchaseRecord[]>([]);

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
        if (mounted) setFreeAvailableAt(status.free_available_at);
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
    onShieldUpdated(selected.id, null);
  }, [onShieldUpdated, selected, selectedRemainingMs]);

  const refreshOptions = useCallback(async () => {
    if (!playerId) return;
    setBusy("loading");
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
      setBusy(null);
    }
  }, [onShieldUpdated, playerId, selected]);

  const openOptions = useCallback(() => {
    setOptionsVisible(true);
    void refreshOptions();
  }, [refreshOptions]);

  const goToPayments = useCallback(() => {
    setOptionsVisible(false);
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
      setMessage(error instanceof Error ? error.message : "No se pudo activar el escudo gratis");
    } finally {
      setBusy(null);
    }
  }, [applyShield, playerId, selected]);

  const payForShield = useCallback(
    (product: ShieldProduct) => {
      if (!selected) {
        const noTerritoryMessage =
          "Lo sentimos, no puedes comprar un escudo todavía. Primero conquista al menos un territorio.";
        setMessage(noTerritoryMessage);
        Alert.alert("No puedes comprar un escudo", noTerritoryMessage);
        return;
      }
      if (!product.configured) return;
      if (!canApplyShieldDuration(selected.shield, product.duration_hours, Date.now())) {
        setMessage("Tu protección total no puede superar 36 horas.");
        return;
      }
      Alert.alert(
        "Confirmar protección",
        `Territorio: ${selected.id}\nDuración: ${product.duration_hours} h\nPrecio: ${formatPrice(product)}\n\nLa protección comenzará después de confirmar el pago.`,
        [
          { text: "Cancelar", style: "cancel" },
          {
            text: "Continuar al pago",
            onPress: () => {
              void (async () => {
                setBusy(product.id);
                setMessage(null);
                const purchaseReference = `${playerId}_${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, "_");
                let purchaseRecord: ShieldPurchaseRecord = {
                  id: purchaseReference,
                  playerId,
                  territoryId: selected.id,
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
                    territoryId: selected.id,
                    playerId,
                    purchaseReference,
                  });
                  purchaseRecord = {
                    ...purchaseRecord,
                    sessionId: session.session_id,
                  };
                  await saveShieldPurchaseRecord(purchaseRecord);
                  if (!session.url) throw new Error("No se pudo preparar la página de pago");
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
                    setMessage("El pago no fue aprobado. Tu territorio no fue modificado.");
                    return;
                  }
                  const confirmed = await confirmShieldCheckout(session.session_id, selected.id, playerId);
                  applyShield(confirmed.shield);
                  purchaseRecord = { ...purchaseRecord, status: "approved" };
                  await saveShieldPurchaseRecord(purchaseRecord);
                  setMessage(
                    `✓ Protección activada.\nTerritorio: ${selected.id}\nDuración: ${product.duration_hours} horas.`,
                  );
                } catch (error) {
                  await saveShieldPurchaseRecord({
                    ...purchaseRecord,
                    status: browserCanceled ? "canceled" : "rejected",
                  }).catch(() => undefined);
                  console.warn("[Protección] No se pudo completar el pago:", error);
                  setMessage("No se pudo completar el pago. Tu territorio no fue modificado.");
                } finally {
                  setBusy(null);
                }
              })();
            },
          },
        ],
      );
    },
    [applyShield, playerId, selected],
  );

  const optionsContent = (
    <>
      {displayMode === "payments" && (
        <View style={styles.currentProtectionCard}>
          <Image
            source={SHIELD_ASSETS[indicator.state]}
            style={styles.currentProtectionImage}
            contentFit="contain"
          />
          <View style={styles.currentProtectionText}>
            <Text style={styles.currentProtectionTitle}>
              {indicator.activeTerritory
                ? indicator.state === "warning"
                  ? "Escudo agotándose"
                  : "Protección activa"
                : "Sin protección activa"}
            </Text>
            {indicator.activeTerritory ? (
              <>
                <Text style={styles.currentProtectionDetail}>
                  Territorio: {indicator.activeTerritory.id}
                </Text>
                <Text style={styles.currentProtectionDetail}>
                  Tiempo restante: {formatShieldRemainingTime(indicator.remainingMs)}
                </Text>
                <Text style={styles.currentProtectionDetail}>
                  Expira: {new Date(indicator.activeTerritory.shield!.expiresAt).toLocaleString("es-MX")}
                </Text>
              </>
            ) : (
              <Text style={styles.currentProtectionDetail}>
                Puedes adquirir protección para uno de tus territorios.
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
            Necesitas conquistar al menos un territorio antes de comprar y activar una protección.
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

      <Text style={styles.sectionTitle}>Comprar protección</Text>
      <Text style={styles.maximumNotice}>Máximo de protección continua: 36 horas</Text>
      <ScrollView style={styles.products} nestedScrollEnabled>
        {busy === "loading" && <ActivityIndicator color="#4DD0E1" />}
        {products.map((product) => (
          <Pressable
            key={product.id}
            disabled={!product.configured || busy !== null}
            onPress={() => payForShield(product)}
            style={[styles.product, (!product.configured || busy !== null) && styles.disabled]}
            accessibilityRole="button"
          >
            <View>
              <Text style={styles.productHours}>Escudo {product.duration_hours} horas</Text>
              <Text style={styles.productProvider}>Pago seguro</Text>
            </View>
            <View style={styles.productActionColumn}>
              <Text style={product.configured ? styles.productPrice : styles.notConfigured}>{formatPrice(product)}</Text>
              <View style={styles.productActionButton}>
                {busy === product.id
                  ? <ActivityIndicator color="#FFFFFF" />
                  : <Text style={styles.productActionText}>
                      {product.configured ? "COMPRAR" : "NO DISPONIBLE"}
                    </Text>}
              </View>
            </View>
          </Pressable>
        ))}
      </ScrollView>
      {message && <Text style={styles.message}>{message}</Text>}
      <Text style={styles.legal}>La protección comenzará después de confirmar el pago.</Text>

      {displayMode === "payments" && (
        <View style={styles.historySection}>
          <Text style={styles.sectionTitle}>Historial de protección</Text>
          {history.length === 0 ? (
            <Text style={styles.mutedHistory}>Todavía no hay compras de protección.</Text>
          ) : history.map((record) => (
            <View key={record.id} style={styles.historyCard}>
              <Text style={styles.historyTitle}>Protección de territorio · {record.durationHours} h</Text>
              <Text style={styles.historyDetail}>Territorio: {record.territoryId}</Text>
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
      )}
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
        style={styles.mapBadge}
        onPress={shouldOpenShieldOptions(indicator.state) ? openOptions : undefined}
        accessibilityRole="button"
      >
        <Image source={SHIELD_ASSETS[indicator.state]} style={styles.badgeImage} contentFit="contain" />
      </Pressable>

      <Modal visible={optionsVisible} transparent animationType="slide" onRequestClose={() => setOptionsVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
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
            {optionsContent}
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
  currentProtectionImage: { width: 72, height: 72 },
  currentProtectionText: { flex: 1, gap: 3 },
  currentProtectionTitle: { color: "#FFFFFF", fontSize: 16, fontWeight: "900" },
  currentProtectionDetail: { color: "#C5CAE9", fontSize: 11, lineHeight: 16 },
  mapBadge: { position: "absolute", left: 16, top: 100, width: 64, height: 64, borderRadius: 18, padding: 8, backgroundColor: "rgba(10,18,42,0.94)", alignItems: "center", justifyContent: "center", elevation: 8 },
  badgeImage: { width: 48, height: 48 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.72)", justifyContent: "flex-end" },
  modalCard: { maxHeight: "88%", backgroundColor: "#101426", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 18, gap: 12 },
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
  freeButton: { backgroundColor: PROTECTION_ACTION_COLOR, borderRadius: 14, padding: 14 },
  freeTitle: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" },
  freeSubtitle: { color: "#E8E7FF", fontSize: 12, marginTop: 4 },
  protectionActionText: { color: "#FFFFFF", fontSize: 12, fontWeight: "900", textAlign: "center" },
  freeActionText: { marginTop: 10 },
  goToPaymentsButton: { backgroundColor: PROTECTION_ACTION_COLOR, borderRadius: 12, minHeight: 46, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  maximumNotice: { color: "#AAB2CF", fontSize: 11, marginTop: -6 },
  products: { maxHeight: 260 },
  product: { backgroundColor: "#252C4D", borderRadius: 13, padding: 14, marginBottom: 9, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  productHours: { color: "#FFFFFF", fontSize: 16, fontWeight: "900" },
  productProvider: { color: "#8993B2", fontSize: 10, marginTop: 3 },
  productPrice: { color: "#72E6BE", fontSize: 16, fontWeight: "900" },
  notConfigured: { color: "#FFB4B4", fontSize: 11, fontWeight: "800" },
  productActionColumn: { alignItems: "flex-end", gap: 7, marginLeft: 10 },
  productActionButton: { backgroundColor: PROTECTION_ACTION_COLOR, borderRadius: 9, minHeight: 34, minWidth: 132, alignItems: "center", justifyContent: "center", paddingHorizontal: 10 },
  productActionText: { color: "#FFFFFF", fontSize: 9, fontWeight: "900", textAlign: "center" },
  disabled: { opacity: 0.5 },
  message: { color: "#FFE082", fontSize: 12, lineHeight: 17 },
  legal: { color: "#7F89AA", fontSize: 10, lineHeight: 15, textAlign: "center" },
  historySection: { gap: 9, marginTop: 4 },
  historyCard: { backgroundColor: "#242B4A", borderRadius: 13, padding: 12, gap: 3 },
  historyTitle: { color: "#FFFFFF", fontSize: 13, fontWeight: "900" },
  historyDetail: { color: "#C5CAE9", fontSize: 11, lineHeight: 16 },
  historyMode: { color: "#FFCC80", fontSize: 10, fontWeight: "900", marginTop: 3 },
  mutedHistory: { color: "#8993B2", fontSize: 12 },
});
