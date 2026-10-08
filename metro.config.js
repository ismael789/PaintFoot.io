const { getDefaultConfig } = require("expo/metro-config");
const { startCompanionServer } = require("./scripts/start-companion-server");

// Expo CLI carga este archivo al ejecutar `npx expo start`. El servidor
// complementario busca puertos libres para WebSocket y Stripe.
if (process.argv.includes("start")) {
  startCompanionServer(__dirname);
}

const config = getDefaultConfig(__dirname);

// Empaqueta los recursos locales usados por Expo Go, el APK y la web.
config.resolver.assetExts.push("html", "wasm");

module.exports = config;
