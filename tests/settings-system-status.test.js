const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");
const home = read("src", "app", "index.tsx");
const profile = read("src", "app", "profile.tsx");
const layout = read("src", "app", "_layout.tsx");
const status = read("src", "services", "game-system-status.ts");

test("el mapa no renderiza indicadores tecnicos ni mensajes locales duplicados", () => {
  assert.doesNotMatch(home, /GPS esperando senal|Mundo local|Calles: listas|Push:/);
  assert.doesNotMatch(home, /<View style=\{styles\.themeRow\}>/);
  assert.doesNotMatch(home, /offlineBadge|syncBadge|territoryNotice/);
  assert.match(home, /Recorrido activo/);
  assert.match(home, /Iniciar recorrido/);
  assert.match(layout, /<GlobalFeedback \/>/);
});

test("Configuracion contiene tema y Estado del sistema", () => {
  assert.match(profile, /Configuracion del juego/);
  assert.match(profile, /Estado del sistema/);
  for (const label of [
    "GPS",
    "Segundo plano",
    "Notificaciones",
    "Mapa global",
    "Calles guardadas",
    "Sensores",
    "Cache regional",
    "Sincronizacion",
    "Modo offline",
  ]) assert.match(profile, new RegExp(label));
});

test("el tema y las acciones reutilizan el estado existente del mapa", () => {
  assert.match(profile, /saveThemePreference\(preference\)/);
  assert.match(profile, /selectGameTheme\(preference\)/);
  assert.match(home, /registerGameSystemActions/);
  assert.match(home, /retryRoadMatching: \(\) => scheduleRoadMatch\(true\)/);
  assert.match(status, /Disponible solo en APK/);
});
