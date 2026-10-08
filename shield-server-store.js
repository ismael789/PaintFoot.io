const fs = require("fs");
const path = require("path");

const HOUR_MS = 60 * 60 * 1000;
const MAX_SHIELD_DURATION_HOURS = 36;
const FREE_SHIELD_COOLDOWN_HOURS = 24;

function createEmptyState() {
  return {
    territoryOwners: {},
    shields: {},
    freeClaims: {},
    processedPayments: {},
    purchasedShields: {},
  };
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

class ShieldServerStore {
  constructor(filePath = path.join(__dirname, ".paintfoot-server-data", "shields.json")) {
    this.filePath = filePath;
    this.state = createEmptyState();
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.state = { ...createEmptyState(), ...parsed };
    } catch (error) {
      if (error.code !== "ENOENT") console.error("[Escudos] Estado no legible:", error.message);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2));
    fs.renameSync(temporaryPath, this.filePath);
  }

  registerTerritory(territoryId, playerId) {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(territoryId || "") ||
        !/^[A-Za-z0-9_.:-]{1,160}$/.test(playerId || "")) return false;
    const currentOwner = this.state.territoryOwners[territoryId];
    const currentShield = this.getActiveShield(territoryId);
    if (currentOwner && currentOwner !== playerId && currentShield) return false;
    this.state.territoryOwners[territoryId] = playerId;
    this.save();
    return true;
  }

  assertOwnership(territoryId, playerId) {
    if (this.state.territoryOwners[territoryId] !== playerId) {
      throw httpError("El territorio no pertenece al jugador", 403);
    }
  }

  getActiveShield(territoryId, now = Date.now()) {
    const shield = this.state.shields[territoryId];
    if (!shield || !Number.isFinite(shield.expiresAt) || shield.expiresAt <= now) return null;
    return shield;
  }

  getStatus(territoryId, playerId, now = Date.now()) {
    this.assertOwnership(territoryId, playerId);
    return {
      shield: this.getActiveShield(territoryId, now),
      ...this.getPlayerStatus(playerId, now),
    };
  }

  getPlayerStatus(playerId, now = Date.now()) {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(playerId || "")) {
      throw httpError("player_id no valido", 400);
    }
    const lastClaimedAt = this.state.freeClaims[playerId] ?? null;
    const freeAvailableAt = lastClaimedAt == null
      ? 0
      : lastClaimedAt + FREE_SHIELD_COOLDOWN_HOURS * HOUR_MS;
    return {
      free_last_claimed_at: lastClaimedAt,
      free_available_at: freeAvailableAt,
      free_available: now >= freeAvailableAt,
      purchased_shields: [...(this.state.purchasedShields[playerId] || [])],
    };
  }

  storePurchasedShield({ playerId, durationHours, productId, paymentId, now = Date.now() }) {
    this.getPlayerStatus(playerId, now);
    if (!Number.isInteger(durationHours) || durationHours <= 0 || durationHours > MAX_SHIELD_DURATION_HOURS) {
      throw httpError("Duracion de escudo no permitida");
    }
    const processed = this.state.processedPayments[paymentId];
    if (processed?.type === "purchased_shield") return processed.purchasedShield;

    const purchasedShield = {
      id: paymentId,
      durationHours,
      productId,
      purchasedAt: now,
    };
    const current = this.state.purchasedShields[playerId] || [];
    this.state.purchasedShields[playerId] = [
      ...current.filter((item) => item.id !== paymentId),
      purchasedShield,
    ];
    this.state.processedPayments[paymentId] = { type: "purchased_shield", purchasedShield };
    this.save();
    return purchasedShield;
  }

  activatePurchasedShield({ territoryId, playerId, purchasedShieldId, now = Date.now() }) {
    this.assertOwnership(territoryId, playerId);
    const redemptionId = `redeem_${purchasedShieldId}`;
    const alreadyRedeemed = this.state.processedPayments[redemptionId];
    if (alreadyRedeemed?.type === "activated_shield") return alreadyRedeemed.shield;

    const purchased = this.state.purchasedShields[playerId] || [];
    const credit = purchased.find((item) => item.id === purchasedShieldId);
    if (!credit) throw httpError("El escudo comprado no esta disponible", 404);

    const shield = this.activate({
      territoryId,
      playerId,
      durationHours: credit.durationHours,
      source: "stripe",
      paymentId: redemptionId,
      now,
    });
    this.state.purchasedShields[playerId] = purchased.filter((item) => item.id !== purchasedShieldId);
    this.state.processedPayments[redemptionId] = { type: "activated_shield", shield };
    this.save();
    return shield;
  }

  activate({ territoryId, playerId, durationHours, source, paymentId = null, now = Date.now() }) {
    this.assertOwnership(territoryId, playerId);
    if (!Number.isInteger(durationHours) || durationHours <= 0 || durationHours > MAX_SHIELD_DURATION_HOURS) {
      throw httpError("Duracion de escudo no permitida");
    }
    if (paymentId && this.state.processedPayments[paymentId]) {
      const processed = this.state.processedPayments[paymentId];
      return processed?.type === "activated_shield" ? processed.shield : processed;
    }

    const current = this.getActiveShield(territoryId, now);
    const startedAt = current ? current.startedAt : now;
    const expiresAt = now + durationHours * HOUR_MS;
    if (expiresAt - startedAt > MAX_SHIELD_DURATION_HOURS * HOUR_MS) {
      throw httpError("La proteccion continua no puede superar 36 horas", 409);
    }

    const shield = { startedAt, expiresAt, durationHours: (expiresAt - startedAt) / HOUR_MS, source, paymentId };
    this.state.shields[territoryId] = shield;
    if (paymentId) this.state.processedPayments[paymentId] = { type: "activated_shield", shield };
    this.save();
    return shield;
  }

  claimFree(territoryId, playerId, now = Date.now()) {
    const status = this.getStatus(territoryId, playerId, now);
    if (status.shield) {
      throw httpError("El escudo gratis no se acumula con una proteccion activa", 409);
    }
    if (!status.free_available) {
      throw httpError("El escudo gratis aun no esta disponible", 409);
    }
    const shield = this.activate({ territoryId, playerId, durationHours: 1, source: "free", now });
    this.state.freeClaims[playerId] = now;
    this.save();
    return { shield, free_available_at: now + FREE_SHIELD_COOLDOWN_HOURS * HOUR_MS };
  }
}

const shieldServerStore = new ShieldServerStore();

module.exports = {
  FREE_SHIELD_COOLDOWN_HOURS,
  MAX_SHIELD_DURATION_HOURS,
  ShieldServerStore,
  shieldServerStore,
};
