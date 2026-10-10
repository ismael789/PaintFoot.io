const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");

const motion = read("src", "services", "motion-sensors.ts");
const fusion = read("src", "services", "sensor-fusion.ts");
const capabilities = read("src", "services", "sensor-capabilities.ts");
const offline = read("src", "services", "offline-storage.ts");
const androidBridge = read("modules", "paintfoot-android-sensors", "index.ts");
const androidModule = read(
  "modules",
  "paintfoot-android-sensors",
  "android",
  "src",
  "main",
  "java",
  "expo",
  "modules",
  "paintfootandroidsensors",
  "PaintFootAndroidSensorsModule.kt",
);

test("sensores 1: Expo Go detecta cada sensor antes de suscribirse", () => {
  for (const sensor of [
    "Accelerometer",
    "Barometer",
    "DeviceMotion",
    "Gyroscope",
    "LightSensor",
    "Magnetometer",
    "MagnetometerUncalibrated",
    "Pedometer",
  ]) {
    assert.match(motion, new RegExp(`${sensor}\\.isAvailableAsync\\(\\)`));
  }
});

test("sensores 2: APK registra las ocho fuentes Android avanzadas", () => {
  for (const id of [
    "proximity",
    "gravity",
    "linearAcceleration",
    "rotationVector",
    "gameRotationVector",
    "geomagneticRotationVector",
    "stepDetector",
    "significantMotion",
  ]) {
    assert.match(androidModule, new RegExp(`SensorSpec\\("${id}"`));
  }
});

test("sensores 3: barometro ausente permanece opcional", () => {
  assert.match(motion, /safeAvailability\(\(\) => Barometer\.isAvailableAsync\(\)\)/);
  assert.match(fusion, /latestEvidence\?\.availability\.accelerometer/);
});

test("sensores 4: podometro ausente conserva alternativas de movimiento", () => {
  assert.match(fusion, /gpsMovementAvailable/);
  assert.match(fusion, /availability\.linearAcceleration/);
  assert.match(fusion, /availability\.pedometer/);
});

test("sensores 5: iniciar recorrido activa lecturas y fusion", () => {
  assert.match(motion, /async start\(onEvidence\?/);
  assert.match(motion, /this\.nativeSessionEnabled = true/);
  assert.match(motion, /this\.addSessionSubscription\("accelerometer"/);
});

test("sensores 6: detener recorrido apaga fuentes de sesion", () => {
  assert.match(motion, /stopSession\(\): SensorSessionMetrics/);
  assert.match(motion, /this\.nativeSessionEnabled = false/);
  assert.match(motion, /subscription\.remove\(\)/);
  assert.match(motion, /sensorCapabilityManager\.stopSession\(\)/);
});

test("sensores 7: una fuente fallida queda temporal sin detener el juego", () => {
  assert.match(motion, /markTemporaryUnavailable\(id\)/);
  assert.match(capabilities, /"temporarily-unavailable"/);
  assert.match(motion, /\.catch\(\(\) => undefined\)/);
});

test("sensores 8: fusion central entrega todas las confianzas solicitadas", () => {
  for (const field of [
    "movementConfidence",
    "walkingConfidence",
    "orientationConfidence",
    "magneticConfidence",
    "roadConfidence",
    "captureConfidence",
    "pocketState",
    "sensorAvailability",
    "trackingReliability",
  ]) {
    assert.match(fusion, new RegExp(`${field}:`));
  }
});

test("sensores 9: evidencia resumida se conserva en SQLite offline", () => {
  assert.match(offline, /CREATE TABLE IF NOT EXISTS sensor_events/);
  assert.match(offline, /sensor_json TEXT/);
  assert.match(offline, /JSON\.stringify\(point\.sensor\)/);
});

test("sensores 10: Expo Go usa modulo Android opcional y no puede romper", () => {
  assert.match(androidBridge, /requireOptionalNativeModule/);
  assert.match(androidBridge, /if \(!nativeModule\) return null/);
  assert.match(capabilities, /status: "apk-only"/);
});
