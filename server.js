const WebSocket = require("ws");
const { startStripeApi } = require("./stripe-api");
const { shieldServerStore } = require("./shield-server-store");

const port = 8082;
const wss = new WebSocket.Server({ port });
const expoPushEndpoint = "https://exp.host/--/api/v2/push/send";

// Almacena la última ubicación y el tiempo de cada jugador
const players = {};
const pushTokens = {};

// API HTTP independiente: no crea tablas ni guarda pagos localmente.
startStripeApi();

function isExpoPushToken(value) {
  return (
    typeof value === "string" &&
    /^(Expo|Exponent)PushToken\[[^\]]+\]$/.test(value)
  );
}

async function sendTerritoryPush(excludedPlayerId, owner) {
  const tokens = [
    ...new Set(
      Object.entries(pushTokens)
        .filter(([playerId]) => playerId !== excludedPlayerId)
        .map(([, token]) => token),
    ),
  ];

  if (tokens.length === 0) return;

  const messages = tokens.map((token) => ({
    to: token,
    sound: "default",
    title: "Territorio conquistado",
    body: `${owner} conquisto un nuevo territorio.`,
    data: { url: "/" },
    channelId: "game-events",
  }));

  const response = await fetch(expoPushEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(messages),
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Expo Push respondio ${response.status}: ${responseBody}`);
  }

  console.log(`[Push] ${tokens.length} notificacion(es) enviada(s).`);
}

wss.on("connection", function connection(ws) {
  console.log("Nuevo cliente conectado");
  let connectedPlayerId = null;
  let lastTerritoryNotificationAt = 0;

  ws.on("message", function incoming(message) {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "player-hello" && typeof data.id === "string") {
        connectedPlayerId = data.id;
      }

      if (data.type === "location") {
        connectedPlayerId = data.id;
        data.timestamp = Date.now();
        players[data.id] = data;

        // Reenviar (broadcast) a todos los demás clientes
        wss.clients.forEach(function each(client) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
          }
        });
      }

      if (
        data.type === "push-token" &&
        typeof data.id === "string" &&
        isExpoPushToken(data.token)
      ) {
        connectedPlayerId = data.id;

        Object.entries(pushTokens).forEach(([playerId, token]) => {
          if (token === data.token && playerId !== data.id) {
            delete pushTokens[playerId];
          }
        });

        pushTokens[data.id] = data.token;
        console.log(`[Push] Token registrado para ${data.id}.`);
      }

      if (
        data.type === "territory-captured" &&
        typeof data.id === "string" &&
        data.id === connectedPlayerId &&
        typeof data.territoryId === "string"
      ) {
        shieldServerStore.registerTerritory(data.territoryId, data.id);
        if (Date.now() - lastTerritoryNotificationAt < 3_000) return;
        lastTerritoryNotificationAt = Date.now();
        const owner =
          typeof data.owner === "string" && data.owner.trim().length > 0
            ? data.owner.trim().slice(0, 40)
            : "Otro jugador";

        void sendTerritoryPush(data.id, owner).catch((error) => {
          console.error("[Push] Error enviando notificaciones:", error.message);
        });
      }

      if (
        data.type === "territory-sync" &&
        typeof data.id === "string" &&
        data.id === connectedPlayerId &&
        Array.isArray(data.territoryIds)
      ) {
        data.territoryIds.slice(0, 500).forEach((territoryId) => {
          if (typeof territoryId === "string") {
            shieldServerStore.registerTerritory(territoryId, data.id);
          }
        });
      }
    } catch (e) {
      console.error("Error procesando mensaje:", e);
    }
  });

  ws.on("close", () => {
    console.log(
      connectedPlayerId
        ? `Cliente desconectado: ${connectedPlayerId}`
        : "Cliente desconectado",
    );
    // El token se conserva para poder notificar aunque la app esté cerrada.
  });
});

console.log(`Servidor WebSocket corriendo en el puerto ${port}`);
