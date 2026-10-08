const { spawn } = require("child_process");

// Conservado por compatibilidad: Metro inicia el servidor complementario
// desde metro.config.js, por lo que aqui solo se inicia Expo.
const expoCli = require.resolve("expo/bin/cli");
const forwardedArgs = process.argv.slice(2);
const hasExplicitPort = forwardedArgs.some(
  (argument, index) =>
    argument === "--port" ||
    argument === "-p" ||
    argument.startsWith("--port=") ||
    (index > 0 && ["--port", "-p"].includes(forwardedArgs[index - 1])),
);
const expoArgs = [expoCli, "start"];
if (!hasExplicitPort) expoArgs.push("--port", "0");
expoArgs.push(...forwardedArgs);

const expo = spawn(process.execPath, expoArgs, {
  stdio: "inherit",
});

expo.once("exit", (code) => {
  process.exitCode = code ?? 0;
});

expo.once("error", (error) => {
  console.error("No se pudo iniciar Expo:", error.message);
  process.exitCode = 1;
});
