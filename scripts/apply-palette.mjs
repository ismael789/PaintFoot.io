// scripts/apply-palette.mjs
// Uso (desde la raíz del proyecto): node scripts/apply-palette.mjs
// Cambia los colores sueltos (#xxxxxx) por tokens de Palette en las pantallas de interfaz.
import fs from 'node:fs';

const FILES = [
  "src/app/explore.tsx",
  "src/app/profile.tsx",
  "src/app/index.tsx",
  "src/app/payments.tsx",
  "src/components/territory-shield-panel.tsx",
  "src/components/offline-simulation-screen.tsx",
  "src/components/auth-gate.tsx",
  "src/components/global-feedback.tsx",
  "src/components/game-intro.tsx",
  "src/components/animated-icon.tsx",
  "src/services/push-notifications.ts",
  "src/components/themed-text.tsx"
];

// token: [colores que se unifican en él]
const TOKENS = {
  white: ['#fff', '#ffffff'],
  black: ['#000', '#000000'],
  navy950: ['#06111f', '#07111f', '#0c1020'],
  navy900: ['#101426', '#11182c', '#151b31', '#1a1a2e', '#222222'],
  navy800: ['#101d31', '#171e36', '#172033', '#172038', '#17213b', '#172944', '#182941', '#1a2940', '#1c2942', '#202744', '#24273c', '#242b4a', '#252c4d'],
  navy700: ['#173f66', '#202d4b', '#222a48', '#233a59', '#263b61', '#283455', '#292b46', '#293454', '#2b385d', '#2b395d', '#2d4768', '#303957', '#313950', '#33405f', '#343b51', '#34405f', '#35405f', '#384152', '#39436b'],
  navy600: ['#3d5682', '#40527e', '#48506a', '#4b5875', '#56627a', '#68758c'],
  navy500: ['#1762a8', '#2867c7', '#315b89', '#315e9e', '#3949ab'],
  sky500: ['#208aef'],
  sky400: ['#3fd8ff', '#40c4ff'],
  sky300: ['#72b8ff', '#72d2ff'],
  sky200: ['#83dfff', '#8edcff', '#a8e7ff'],
  ice50: ['#f1f5ff', '#f2f4fa', '#f5faff', '#f7f9fe', '#f7faff'],
  ice100: ['#d7e5f5', '#e3e7ef', '#e8e7ff', '#e8eef9', '#e9ecf5', '#eef3fc'],
  ice200: ['#c3cae0', '#c8d0e3', '#cad0e3'],
  textSoft: ['#b9c6db', '#b9d8ff', '#c5cae9', '#d6daea', '#e0e0e0', '#e8edf2'],
  textSecondary: ['#9da8c6', '#9ea8c4', '#9fa8da', '#9fa8ff', '#9fa9c5', '#aab2cf', '#aab9d3', '#b0b7ca', '#b39ddb', '#cbd5df'],
  textMuted: ['#6e7897', '#6f7897', '#707a99', '#7982a2', '#7f89aa', '#8390ae', '#858fac', '#8993b2', '#8a94a6', '#8c97b8', '#8e99b9', '#929bb8', '#9e9e9e'],
  success: ['#55d98a', '#72e6be', '#80cbc4'],
  successStrong: ['#4caf50'],
  warning: ['#e58b18', '#ff8800', '#ffcc80'],
  gold: ['#ffc857', '#ffd54a', '#ffe082', '#fff3a6'],
  danger: ['#ff4444'],
  dangerSoft: ['#ff6b7a', '#ff8a80'],
};

const MAP = {};
for (const [token, hexes] of Object.entries(TOKENS)) {
  for (const hex of hexes) MAP[hex] = token;
}

const PATTERN = /(=?)(["'])(#[0-9a-fA-F]{3,6})\2/g;
const IMPORT_LINE = 'import { Palette } from "@/constants/palette";';

let total = 0;
for (const file of FILES) {
  const original = fs.readFileSync(file, 'utf8');
  let count = 0;
  let next = original.replace(PATTERN, (match, eq, _quote, hex) => {
    const token = MAP[hex.toLowerCase()];
    if (!token) return match;
    count += 1;
    return eq ? `={Palette.${token}}` : `Palette.${token}`;
  });
  if (count > 0 && !next.includes(IMPORT_LINE)) {
    const lines = next.split('\n');
    const first = lines.findIndex((line) => line.startsWith('import '));
    lines.splice(first, 0, IMPORT_LINE);
    next = lines.join('\n');
  }
  if (count > 0) fs.writeFileSync(file, next);
  total += count;
  console.log(`${file}: ${count} colores`);
}
console.log(`Total: ${total}`);