const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const LAUNCH_STATE = Symbol.for("paintfoot.companion-server-launch-state");

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLaunchLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function acquireLaunchLock(projectRoot) {
  const lockPath = path.join(projectRoot, ".expo", "paintfoot-companion.json");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      fs.writeFileSync(
        descriptor,
        JSON.stringify({ ownerPid: process.pid, childPid: null }),
      );
      fs.closeSync(descriptor);
      return { acquired: true, lockPath };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const lock = readLaunchLock(lockPath);
      if (
        isProcessRunning(Number(lock?.ownerPid)) ||
        isProcessRunning(Number(lock?.childPid))
      ) {
        return { acquired: false, lockPath };
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      }
    }
  }

  return { acquired: false, lockPath };
}

function releaseLaunchLock(lockPath) {
  const lock = readLaunchLock(lockPath);
  if (Number(lock?.ownerPid) !== process.pid) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("[PaintFoot] No se pudo limpiar el bloqueo:", error.message);
    }
  }
}

function startCompanionServer(projectRoot) {
  if (process.env.PAINTFOOT_SKIP_COMPANION_SERVER === "1") return;
  if (globalThis[LAUNCH_STATE]) return;
  const launchLock = acquireLaunchLock(projectRoot);
  if (!launchLock.acquired) {
    globalThis[LAUNCH_STATE] = { status: "already-running", child: null };
    console.log("[PaintFoot] El servidor complementario ya esta ejecutandose.");
    return;
  }

  const serverPath = path.join(projectRoot, "server.js");
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: { ...process.env, PAINTFOOT_STARTED_BY_EXPO: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  fs.writeFileSync(
    launchLock.lockPath,
    JSON.stringify({ ownerPid: process.pid, childPid: child.pid }),
  );
  globalThis[LAUNCH_STATE] = { status: "running", child };
  console.log("[PaintFoot] Servidor WebSocket y Stripe iniciado junto con Expo.");

  child.once("error", (error) => {
    globalThis[LAUNCH_STATE].status = "error";
    releaseLaunchLock(launchLock.lockPath);
    console.error("[PaintFoot] No se pudo iniciar el servidor:", error.message);
  });
  child.once("exit", (code, signal) => {
    if (globalThis[LAUNCH_STATE].status === "stopping") return;
    globalThis[LAUNCH_STATE] = { status: "stopped", child: null };
    releaseLaunchLock(launchLock.lockPath);
    console.log(
      `[PaintFoot] Servidor finalizado${signal ? ` por ${signal}` : ` con codigo ${code ?? 0}`}.`,
    );
  });

  process.once("exit", () => {
    if (!child.killed) {
      globalThis[LAUNCH_STATE].status = "stopping";
      child.kill();
    }
    releaseLaunchLock(launchLock.lockPath);
  });
}

module.exports = { startCompanionServer };
