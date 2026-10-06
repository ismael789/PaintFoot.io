const { spawn } = require("child_process");
const os = require("os");

// Conservado por compatibilidad: Metro inicia el servidor complementario
// desde metro.config.js, por lo que aqui solo se inicia Expo.
const npxCommand = os.platform() === "win32" ? "npx.cmd" : "npx";
const expo = spawn(npxCommand, ["expo", "start", ...process.argv.slice(2)], {
  stdio: "inherit",
});

expo.once("exit", (code) => {
  process.exitCode = code ?? 0;
});

expo.once("error", (error) => {
  console.error("No se pudo iniciar Expo:", error.message);
  process.exitCode = 1;
});
