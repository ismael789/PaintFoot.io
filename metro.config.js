const { getDefaultConfig } = require("expo/metro-config");
const { startCompanionServer } = require("./scripts/start-companion-server");

// Expo CLI carga este archivo al ejecutar `npx expo start`. El servidor
// complementario abre WebSocket 8082 y la API Stripe 4000 una sola vez.
if (process.argv.includes("start")) {
  startCompanionServer(__dirname);
}

const config = getDefaultConfig(__dirname);

// Empaqueta la animacion original para usarla sin red en Expo Go y en el APK.
config.resolver.assetExts.push("html");

module.exports = config;
