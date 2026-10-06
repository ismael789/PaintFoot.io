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
  | "interference";

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
  { id: "lightSensor", name: "Sensor de luz", category: "Entorno", purpose: "Tema automatico", runtime: "expo" },
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

    this.states = this.states.map((state) => {
      const expoValue = expoAvailability[state.id];
      if (expoValue !== undefined) {
        return {
          ...state,
          available: expoValue,
          active: expoValue ? state.active : false,
          status: expoValue
            ? state.active
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
    const state = this.states.find(({ id }) => id === "gps");
    this.patch("gps", {
      available: state?.available ?? true,
      active,
      status:
        accuracy !== null && accuracy > 20
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
      const magneticInterference =
        (state.id === "magnetometer" ||
          state.id === "uncalibratedMagnetometer" ||
          state.id === "compass") &&
        evidence.magneticConfidence === "low";
      return {
        ...state,
        available: isAvailable || state.available === true,
        active: isAvailable,
        status: magneticInterference
          ? "interference"
          : isAvailable
            ? "active"
            : state.available
              ? "available"
              : "unavailable",
        value: values[state.id] ?? state.value,
        lastUpdated: isAvailable ? evidence.timestamp : state.lastUpdated,
      };
    });
    this.emit();
  }

  publishNativeActive(ids: AndroidSensorId[]) {
    const activeIds = new Set(ids);
    this.states = this.states.map((state) =>
      state.runtime !== "apk" || state.status === "apk-only"
        ? state
        : {
            ...state,
            active: activeIds.has(state.id as AndroidSensorId),
            status: activeIds.has(state.id as AndroidSensorId)
              ? "active"
              : state.available
                ? "available"
                : "unavailable",
          },
    );
    this.emit();
  }

  stopSession() {
    this.states = this.states.map((state) =>
      SESSION_SENSOR_IDS.includes(state.id) && state.active
        ? { ...state, active: false, status: "available" }
        : state,
    );
    this.emit();
  }

  markTemporaryUnavailable(id: SensorCapabilityId) {
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
