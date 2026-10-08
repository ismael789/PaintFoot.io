const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");
const WebSocket = require("ws");

const { startWebSocketServer } = require("../server");
const { startStripeApi } = require("../stripe-api");

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function waitUntilListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve) => server.once("listening", resolve));
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("Stripe usa el siguiente puerto cuando el preferido esta ocupado", async () => {
  const blocker = net.createServer();
  const occupiedPort = await listen(blocker);
  const stripeServer = startStripeApi(occupiedPort);

  try {
    await waitUntilListening(stripeServer);
    const selectedPort = stripeServer.address().port;
    assert.ok(selectedPort > occupiedPort);
    const response = await fetch(
      `http://127.0.0.1:${selectedPort}/api/stripe/config`,
    );
    assert.equal(response.headers.get("X-PaintFoot-Server"), "stripe-api");
  } finally {
    await close(stripeServer);
    await close(blocker);
  }
});

test("WebSocket usa el siguiente puerto cuando el preferido esta ocupado", async () => {
  const blocker = net.createServer();
  const occupiedPort = await listen(blocker);
  const previousMetroPort = process.env.RCT_METRO_PORT;
  process.env.RCT_METRO_PORT = String(occupiedPort + 1);
  const { httpServer, webSocketServer } = startWebSocketServer(occupiedPort);

  try {
    await waitUntilListening(httpServer);
    const selectedPort = httpServer.address().port;
    assert.ok(selectedPort > occupiedPort + 1);
    const readyMessage = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${selectedPort}`);
      client.once("message", (message) => {
        resolve(JSON.parse(message.toString()));
        client.close();
      });
      client.once("error", reject);
    });
    assert.deepEqual(readyMessage, {
      type: "server-ready",
      service: "paintfoot",
    });
  } finally {
    if (previousMetroPort === undefined) delete process.env.RCT_METRO_PORT;
    else process.env.RCT_METRO_PORT = previousMetroPort;
    webSocketServer.close();
    await close(httpServer);
    await close(blocker);
  }
});
