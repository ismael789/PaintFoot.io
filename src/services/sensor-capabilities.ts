import * as Location from "expo-location";
import {
  Accelerometer,
  Barometer,
  DeviceMotion,
  Gyroscope,
  LightSensor,
  Magnetometer,
  MagnetometerUncalibrated,
  Pedometer,
} from "expo-sensors";

import {
  getAndroidSensorCapabilities,
  isAndroidNativeSensorsModuleAvailable,
  type AndroidSensorCapability,
  type AndroidSensorId,
} from "../../modules/paintfoot-android-sensors";
import { SENSOR_RULES } from "../config/territory";
import type { ConfidenceLevel, SensorEvidence } from "../types/game";
import { resolveCapabilityStatus } from "./sensor-capability-logic";

export type SensorCapabilityId =
  | "gps"
  | "compass"
  | "accelerometer"
  | "gyroscope"
  | "deviceMotion"
  | "magnetometer"
  | "uncalibratedMagnetometer"
  | "pedometer"
  | "barometer"
  | "lightSensor"
  | AndroidSensorId;

export type SensorCategory =
  | "Ubicacion"
  | "Movimiento"
  | "Orientacion"
  | "Actividad"
  | "Entorno";

export type SensorRuntime = "expo" | "apk";
export type SensorOperationalStatus =
  | "checking"
  | "available"
  | "active"
  | "unavailable"
  | "temporarily-unavailable"
  | "apk-only"
  | "low-accuracy"
  | "interference"
  | "permission-denied";

export interface SensorCapabilityState {
  id: SensorCapabilityId;
  name: string;
  category: SensorCategory;
  purpose: string;
  runtime: SensorRuntime;
  available: boolean | null;
  active: boolean;
  status: SensorOperationalStatus;
  value?: string;
  details?: AndroidSensorCapability;
  lastUpdated?: number;
}

const DEFINITIONS: Omit<
  SensorCapabilityState,
  "available" | "active" | "status"
>[] = [
  { id: "gps", name: "GPS", category: "Ubicacion", purpose: "Posicion principal para el recorrido", runtime: "expo" },
  { id: "compass", name: "Brujula", category: "Ubicacion", purpose: "Rumbo absoluto", runtime: "expo" },
  { id: "accelerometer", name: "Acelerometro", category: "Movimiento", purpose: "Movimiento fisico con gravedad", runtime: "expo" },
  { id: "gyroscope", name: "Giroscopio", category: "Movimiento", purpose: "Velocidad de giro", runtime: "expo" },
  { id: "deviceMotion", name: "DeviceMotion", category: "Movimiento", purpose: "Movimiento y rotacion combinados", runtime: "expo" },
  { id: "gravity", name: "Gravity", category: "Movimiento", purpose: "Vector de gravedad separado", runtime: "apk" },
  { id: "linearAcceleration", name: "Linear Acceleration", category: "Movimiento", purpose: "Movimiento sin gravedad", runtime: "apk" },
  { id: "rotationVector", name: "Rotation Vector", category: "Orientacion", purpose: "Orientacion 3D fusionada por Android", runtime: "apk" },
  { id: "gameRotationVector", name: "Game Rotation Vector", category: "Orientacion", purpose: "Orientacion sin campo magnetico", runtime: "apk" },
  { id: "geomagneticRotationVector", name: "Geomagnetic Rotation Vector", category: "Orientacion", purpose: "Fallback de orientacion de bajo consumo", runtime: "apk" },
  { id: "pedometer", name: "Podometro", category: "Actividad", purpose: "Conteo acumulado de pasos", runtime: "expo" },
  { id: "stepDetector", name: "Step Detector", category: "Actividad", purpose: "Eventos de pasos en tiempo real", runtime: "apk" },
  { id: "significantMotion", name: "Significant Motion", category: "Actividad", purpose: "Reanudacion de movimiento y eficiencia", runtime: "apk" },
  { id: "barometer", name: "Barometro", category: "Entorno", purpose: "Presion y desnivel aproximado", runtime: "expo" },
  { id: "lightSensor", name: "Sensor de luz", category: "Entorno", purpose: "Claro u oscuro solo con Tema Auto", runtime: "expo" },
  { id: "proximity", name: "Proximidad", category: "Entorno", purpose: "Deteccion de bolsillo", runtime: "apk" },
  { id: "magnetometer", name: "Magnetometro calibrado", category: "Entorno", purpose: "Campo magnetico utilizable", runtime: "expo" },
  { id: "uncalibratedMagnetometer", name: "Magnetometro sin calibrar", category: "Entorno", purpose: "Interferencia y confianza magnetica", runtime: "expo" },
];

const SESSION_SENSOR_IDS: SensorCapabilityId[] = DEFINITIONS.map(
  ({ id }) => id,
).filter(
  (id) => id !== "gps" && id !== "lightSensor",
);

function safeAvailability(check: () => Promise<boolean>) {
  return check().catch(() => false);
}

class SensorCapabilityManager {
  private listeners = new Set<() => void>();
  private permissionDeniedIds = new Set<SensorCapabilityId>();
  private lowAccuracyIds = new Set<SensorCapabilityId>();
  private temporaryFailureAt = new Map<SensorCapabilityId, number>();
  private states: SensorCapabilityState[] = DEFINITIONS.map((definition) => ({
    ...definition,
    available: null,
    active: false,
    status: "checking",
  }));

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.states;

  private emit() {
    this.states = [...this.states];
    for (const listener of this.listeners) listener();
  }

  private patch(
    id: SensorCapabilityId,
    values: Partial<SensorCapabilityState>,
    emit = true,
  ) {
    this.states = this.states.map((state) =>
      state.id === id ? { ...state, ...values } : state,
    );
    if (emit) this.emit();
  }

  async refresh() {
    const [
      gps,
      accelerometer,
      barometer,
      deviceMotion,
      gyroscope,
      lightSensor,
      magnetometer,
      pedometer,
      uncalibratedMagnetometer,
      nativeCapabilities,
      locationPermission,
    ] = await Promise.all([
      safeAvailability(() => Location.hasServicesEnabledAsync()),
      safeAvailability(() => Accelerometer.isAvailableAsync()),
      safeAvailability(() => Barometer.isAvailableAsync()),
      safeAvailability(() => DeviceMotion.isAvailableAsync()),
      safeAvailability(() => Gyroscope.isAvailableAsync()),
      safeAvailability(() => LightSensor.isAvailableAsync()),
      safeAvailability(() => Magnetometer.isAvailableAsync()),
      safeAvailability(() => Pedometer.isAvailableAsync()),
      safeAvailability(() => MagnetometerUncalibrated.isAvailableAsync()),
      getAndroidSensorCapabilities().catch(() => null),
      Location.getForegroundPermissionsAsync().catch(() => null),
    ]);

    const expoAvailability: Partial<Record<SensorCapabilityId, boolean>> = {
      gps,
      compass: gps && magnetometer,
      accelerometer,
      barometer,
      deviceMotion,
      gyroscope,
      lightSensor,
      magnetometer,
      pedometer,
      uncalibratedMagnetometer,
    };

    if (locationPermission?.status === "denied") {
      this.permissionDeniedIds.add("gps");
      this.permissionDeniedIds.add("compass");
    } else if (locationPermission?.status === "granted") {
      this.permissionDeniedIds.delete("gps");
      this.permissionDeniedIds.delete("compass");
    }

    this.states = this.states.map((state) => {
      const expoValue = expoAvailability[state.id];
      if (expoValue !== undefined) {
        return {
          ...state,
          available: expoValue,
          active: expoValue ? state.active : false,
          status: expoValue
            ? this.permissionDeniedIds.has(state.id)
              ? "permission-denied"
              : state.active
                ? "active"
                : "available"
            : "unavailable",
        };
      }

      const native = nativeCapabilities?.find(
        (capability) => capability.id === state.id,
      );
      if (!isAndroidNativeSensorsModuleAvailable) {
        return {
          ...state,
          available: null,
          active: false,
          status: "apk-only" as const,
        };
      }
      if (!nativeCapabilities) {
        return {
          ...state,
          available: null,
          active: false,
          status: "temporarily-unavailable" as const,
        };
      }
      return {
        ...state,
        available: native?.available ?? false,
        active: native?.available ? state.active : false,
        status: resolveCapabilityStatus({
          requiresNativeModule: true,
          nativeModuleAvailable: true,
          detected: native?.available ?? false,
          active: Boolean(native?.available && state.active),
        }),
        details: native,
      };
    });
    this.emit();
    return this.states;
  }

  publishGps(active: boolean, accuracy: number | null) {
    if (active) this.permissionDeniedIds.delete("gps");
    const state = this.states.find(({ id }) => id === "gps");
    this.patch("gps", {
      available: state?.available ?? true,
      active,
      status:
        this.permissionDeniedIds.has("gps")
          ? "permission-denied"
          : accuracy !== null && accuracy > 20
          ? "low-accuracy"
          : active
            ? "active"
            : "available",
      value: accuracy === null ? undefined : `±${Math.round(accuracy)} m`,
      lastUpdated: Date.now(),
    });
  }

  publishEvidence(evidence: SensorEvidence) {
    const availability = evidence.availability;
    if (evidence.activeSensors?.compass) {
      this.permissionDeniedIds.delete("compass");
    }
    const values: Partial<Record<SensorCapabilityId, string | undefined>> = {
      compass:
        evidence.compassHeadingDegrees === null
          ? undefined
          : `${Math.round(evidence.compassHeadingDegrees)}°`,
      accelerometer:
        evidence.accelerationDeltaG === null
          ? undefined
          : `${evidence.accelerationDeltaG.toFixed(2)} g`,
      gyroscope:
        evidence.gyroscopeRotationRateRadS === null
          ? undefined
          : `${evidence.gyroscopeRotationRateRadS.toFixed(2)} rad/s`,
      pedometer:
        evidence.sessionStepCount === null ||
        evidence.sessionStepCount === undefined
          ? undefined
          : `${evidence.sessionStepCount.toLocaleString()} pasos`,
      barometer:
        evidence.pressureHpa === null || evidence.pressureHpa === undefined
          ? undefined
          : `${Math.round(evidence.pressureHpa)} hPa`,
      lightSensor:
        evidence.ambientLightLux === null ||
        evidence.ambientLightLux === undefined
          ? undefined
          : `${Math.round(evidence.ambientLightLux).toLocaleString()} lux`,
      proximity:
        evidence.proximityNear === null || evidence.proximityNear === undefined
          ? undefined
          : evidence.proximityNear
            ? "Cerca"
            : "Lejos",
      gravity: evidence.gravityVectorMps2
        ? `${Math.hypot(
            evidence.gravityVectorMps2.x,
            evidence.gravityVectorMps2.y,
            evidence.gravityVectorMps2.z,
          ).toFixed(2)} m/s²`
        : undefined,
      linearAcceleration:
        evidence.linearAccelerationMps2 === null ||
        evidence.linearAccelerationMps2 === undefined
          ? undefined
          : `${evidence.linearAccelerationMps2.toFixed(2)} m/s²`,
      rotationVector:
        evidence.rotationVectorHeadingDegrees === null ||
        evidence.rotationVectorHeadingDegrees === undefined
          ? undefined
          : `${Math.round(evidence.rotationVectorHeadingDegrees)}°`,
      gameRotationVector:
        evidence.gameRotationVectorHeadingDegrees === null ||
        evidence.gameRotationVectorHeadingDegrees === undefined
          ? undefined
          : `${Math.round(evidence.gameRotationVectorHeadingDegrees)}° relativo`,
      geomagneticRotationVector:
        evidence.geomagneticRotationVectorHeadingDegrees === null ||
        evidence.geomagneticRotationVectorHeadingDegrees === undefined
          ? undefined
          : `${Math.round(evidence.geomagneticRotationVectorHeadingDegrees)}°`,
      stepDetector:
        evidence.stepDetectorCount === null ||
        evidence.stepDetectorCount === undefined
          ? undefined
          : `${evidence.stepDetectorCount} pasos`,
      significantMotion: evidence.significantMotionDetected
        ? "Movimiento detectado"
        : undefined,
      magnetometer:
        evidence.magneticFieldMicrotesla === null
          ? undefined
          : `${Math.round(evidence.magneticFieldMicrotesla)} µT`,
      uncalibratedMagnetometer:
        evidence.rawMagneticFieldMicrotesla === null ||
        evidence.rawMagneticFieldMicrotesla === undefined
          ? undefined
          : `${Math.round(evidence.rawMagneticFieldMicrotesla)} µT`,
    };

    this.states = this.states.map((state) => {
      const isAvailable = Boolean(
        availability[state.id as keyof typeof availability],
      );
      if (state.id === "gps") return state;
      if (state.runtime === "apk" && state.status === "apk-only") return state;
      const isActive = evidence.activeSensors
        ? evidence.activeSensors[
            state.id as keyof typeof evidence.activeSensors
          ] === true
        : values[state.id] !== undefined;
      const readingAt =
        evidence.sensorReadingsAt?.[
          state.id as keyof NonNullable<SensorEvidence["sensorReadingsAt"]>
        ] ?? 0;
      const failureAt = this.temporaryFailureAt.get(state.id) ?? 0;
      if (readingAt > failureAt) {
        this.temporaryFailureAt.delete(state.id);
      }
      const temporarilyUnavailable =
        this.temporaryFailureAt.has(state.id) && readingAt <= failureAt;
      const magneticInterference =
        (state.id === "magnetometer" ||
          state.id === "uncalibratedMagnetometer" ||
          state.id === "compass") &&
        isActive && evidence.magneticConfidence === "low";
      const lowAccuracy =
        this.lowAccuracyIds.has(state.id) ||
        (state.id === "compass" &&
          isActive &&
          evidence.compassAccuracy !== null &&
          evidence.compassAccuracy < SENSOR_RULES.minimumCompassAccuracy);
      return {
        ...state,
        available: isAvailable || state.available === true,
        active: isActive,
        status: this.permissionDeniedIds.has(state.id)
          ? "permission-denied"
          : temporarilyUnavailable
            ? "temporarily-unavailable"
            : magneticInterference
              ? "interference"
              : lowAccuracy
                ? "low-accuracy"
                : isActive
                  ? "active"
            : state.available
              ? "available"
              : "unavailable",
        value: values[state.id] ?? state.value,
        lastUpdated: isActive ? evidence.timestamp : state.lastUpdated,
      };
    });
    this.emit();
  }

  publishDetectedAvailability(availability: SensorEvidence["availability"]) {
    this.states = this.states.map((state) => {
      if (state.id === "gps") return state;
      if (state.runtime === "apk" && state.status === "apk-only") return state;
      const detected = availability[state.id as keyof typeof availability];
      if (detected === undefined) return state;
      return {
        ...state,
        available: detected,
        active: detected ? state.active : false,
        status: this.permissionDeniedIds.has(state.id)
          ? "permission-denied"
          : detected
            ? state.active
              ? state.status
              : "available"
            : "unavailable",
      };
    });
    this.emit();
  }

  publishPermissionIssues(issues: ("motion" | "pedometer")[]) {
    const denied = new Set(issues);
    const motionIds: SensorCapabilityId[] = [
      "accelerometer",
      "gyroscope",
      "deviceMotion",
      "magnetometer",
      "uncalibratedMagnetometer",
    ];
    for (const id of motionIds) {
      if (denied.has("motion")) this.permissionDeniedIds.add(id);
      else this.permissionDeniedIds.delete(id);
    }
    if (denied.has("pedometer")) this.permissionDeniedIds.add("pedometer");
    else this.permissionDeniedIds.delete("pedometer");
    this.states = this.states.map((state) =>
      this.permissionDeniedIds.has(state.id)
        ? { ...state, active: false, status: "permission-denied" }
        : state.status === "permission-denied"
          ? {
              ...state,
              status: state.available ? "available" : "unavailable",
            }
          : state,
    );
    this.emit();
  }

  publishNativeRegistered(ids: AndroidSensorId[]) {
    const registeredIds = new Set(ids);
    this.states = this.states.map((state) =>
      state.runtime !== "apk" || state.status === "apk-only"
        ? state
        : {
            ...state,
            available:
              registeredIds.has(state.id as AndroidSensorId) || state.available,
            active: false,
            status: registeredIds.has(state.id as AndroidSensorId)
              ? "available"
              : state.available === false
                ? "unavailable"
                : state.status,
          },
    );
    this.emit();
  }

  publishNativeAccuracy(id: AndroidSensorId, accuracy: number) {
    if (accuracy <= 0) this.lowAccuracyIds.add(id);
    else this.lowAccuracyIds.delete(id);
    const state = this.states.find((candidate) => candidate.id === id);
    if (!state || state.status === "apk-only") return;
    this.patch(id, {
      status:
        accuracy <= 0
          ? "low-accuracy"
          : state.active
            ? "active"
            : state.available
              ? "available"
              : state.status,
    });
  }

  stopSession() {
    this.states = this.states.map((state) =>
      SESSION_SENSOR_IDS.includes(state.id) && state.active
        ? {
            ...state,
            active: false,
            status: this.lowAccuracyIds.has(state.id)
              ? "low-accuracy"
              : "available",
          }
        : state,
    );
    this.emit();
  }

  markTemporaryUnavailable(id: SensorCapabilityId) {
    const current = this.states.find((state) => state.id === id);
    if (
      current?.status === "apk-only" ||
      this.permissionDeniedIds.has(id)
    ) {
      return;
    }
    this.temporaryFailureAt.set(id, Date.now());
    this.patch(id, {
      active: false,
      status: "temporarily-unavailable",
    });
  }

  getConfidence(): ConfidenceLevel {
    const available = this.states.filter((state) => state.available).length;
    if (available >= 14) return "high";
    if (available >= 9) return "medium";
    return "low";
  }
}

export const sensorCapabilityManager = new SensorCapabilityManager();
export const SENSOR_CATEGORIES: SensorCategory[] = [
  "Ubicacion",
  "Movimiento",
  "Orientacion",
  "Actividad",
  "Entorno",
];
