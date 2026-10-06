const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const LAUNCH_STATE = Symbol.for("paintfoot.companion-server-launch-state");

function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function startCompanionServer(projectRoot) {
  if (process.env.PAINTFOOT_SKIP_COMPANION_SERVER === "1") return;
  if (globalThis[LAUNCH_STATE]) return;
  globalThis[LAUNCH_STATE] = { status: "checking", child: null };

  void isPortOpen(8082).then((alreadyRunning) => {
    if (alreadyRunning) {
      globalThis[LAUNCH_STATE].status = "already-running";
      console.log("[PaintFoot] Servidor WebSocket/Stripe ya esta ejecutandose.");
      return;
    }

    const serverPath = path.join(projectRoot, "server.js");
    const child = spawn(process.execPath, [serverPath], {
      cwd: projectRoot,
      env: { ...process.env, PAINTFOOT_STARTED_BY_EXPO: "1" },
      stdio: "inherit",
      windowsHide: true,
    });
    globalThis[LAUNCH_STATE] = { status: "running", child };
    console.log("[PaintFoot] Servidor WebSocket y Stripe iniciado junto con Expo.");

    child.once("error", (error) => {
      globalThis[LAUNCH_STATE].status = "error";
      console.error("[PaintFoot] No se pudo iniciar el servidor:", error.message);
    });
    child.once("exit", (code, signal) => {
      if (globalThis[LAUNCH_STATE].status === "stopping") return;
      globalThis[LAUNCH_STATE] = { status: "stopped", child: null };
      console.log(
        `[PaintFoot] Servidor finalizado${signal ? ` por ${signal}` : ` con codigo ${code ?? 0}`}.`,
      );
    });

    process.once("exit", () => {
      if (!child.killed) {
        globalThis[LAUNCH_STATE].status = "stopping";
        child.kill();
      }
    });
  });
}

module.exports = { isPortOpen, startCompanionServer };
