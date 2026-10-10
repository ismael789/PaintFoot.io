
import { Platform } from "react-native";

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

import { SENSOR_RULES } from "../config/territory";

import {
  type AndroidSensorEvent,
  type AndroidSensorId,
  startAndroidSensors,
  stopAndroidSensors,
} from "../../modules/paintfoot-android-sensors";

import {
  calculateMagneticConfidence,
  detectProbablePocket,
  SensorSessionAccumulator,
} from "./sensor-metrics";

import {
  sensorCapabilityManager,
  type SensorCapabilityId,
} from "./sensor-capabilities";

import type {
  SensorAvailability,
  SensorEvidence,
  SensorSessionMetrics,
} from "../types/game";

interface RemovableSubscription {
  remove(): void;
}

type EvidenceListener = (evidence: SensorEvidence) => void;

const EMPTY_AVAILABILITY: SensorAvailability = {
  accelerometer: false,
  barometer: false,
  compass: false,
  deviceMotion: false,
  gyroscope: false,
  lightSensor: false,
  magnetometer: false,
  pedometer: false,
  proximity: false,
  gravity: false,
  linearAcceleration: false,
  rotationVector: false,
  gameRotationVector: false,
  geomagneticRotationVector: false,
  stepDetector: false,
  significantMotion: false,
  uncalibratedMagnetometer: false,
};

function safeAvailability(check: () => Promise<boolean>) {
  return check().catch(() => false);
}

function emptyEvidence(lightSensor = false): SensorEvidence {
  return {
    timestamp: 0,
    availability: { ...EMPTY_AVAILABILITY, lightSensor },
    activeSensors: { ...EMPTY_AVAILABILITY },
    sensorReadingsAt: {},
    compassAccuracy: null,
    compassHeadingDegrees: null,
    gyroscopeRotationRateRadS: null,
    deviceMotionRotationRateDegS: null,
    accelerationDeltaG: null,
    magneticFieldMicrotesla: null,
    rawMagneticFieldMicrotesla: null,
    magneticFieldInstabilityMicrotesla: null,
    magneticConfidence: "low",
    sessionStepCount: null,
    dailyStepCount: null,
    pressureHpa: null,
    relativeElevationMeters: null,
    ascentMeters: 0,
    descentMeters: 0,
    ambientLightLux: null,
    proximityNear: null,
    probablePocket: false,
    gravityVectorMps2: null,
    linearAccelerationMps2: null,
    rotationVectorHeadingDegrees: null,
    gameRotationVectorHeadingDegrees: null,
    geomagneticRotationVectorHeadingDegrees: null,
    stepDetectorCount: null,
    significantMotionDetected: false,
    moving: null,
  };
}

export class MotionSensorTracker {
  private active = false;
  private generation = 0;
  private subscriptions: RemovableSubscription[] = [];
  private lightSubscription: RemovableSubscription | null = null;
  private evidence = emptyEvidence();
  private accumulator = new SensorSessionAccumulator();
  private evidenceListener: EvidenceListener | null = null;
  private lastEvidenceNotificationAt = 0;
  private rawMagneticSamples: number[] = [];
  private nativeSubscription: RemovableSubscription | null = null;
  private nativeSessionEnabled = false;
  private nativeProximityEnabled = false;
  private nativeSyncGeneration = 0;
  private nativeSyncPromise: Promise<void> = Promise.resolve();
  private lightRequestId = 0;
  private permissionIssues: ("motion" | "pedometer")[] = [];
  private lightListener:
    | ((illuminanceLux: number, proximityNear: boolean | null) => void)
    | null = null;
  private nativeLastReadingAt = new Map<AndroidSensorId, number>();
  private nativeWatchdog: ReturnType<typeof setInterval> | null = null;
  private sessionWatchdog: ReturnType<typeof setInterval> | null = null;
  private sessionStartedAt = 0;

  private startSessionWatchdog() {
    if (this.sessionWatchdog) clearInterval(this.sessionWatchdog);
    const continuousIds: (keyof SensorAvailability)[] = [
      "accelerometer",
      "barometer",
      "compass",
      "deviceMotion",
      "gyroscope",
      "magnetometer",
      "uncalibratedMagnetometer",
      "proximity",
      "gravity",
      "linearAcceleration",
      "rotationVector",
      "gameRotationVector",
      "geomagneticRotationVector",
    ];
    this.sessionWatchdog = setInterval(() => {
      if (!this.active) return;
      const now = Date.now();
      for (const id of continuousIds) {
        if (!this.evidence.availability[id]) continue;
        const lastReading =
          this.evidence.sensorReadingsAt?.[id] ?? this.sessionStartedAt;
        if (
          now - lastReading >
          SENSOR_RULES.nativeContinuousSensorTimeoutMs
        ) {
          if (this.evidence.activeSensors) {
            this.evidence.activeSensors[id] = false;
          }
          sensorCapabilityManager.markTemporaryUnavailable(id);
        }
      }
    }, SENSOR_RULES.nativeContinuousSensorTimeoutMs / 2);
  }

  private refreshMetrics() {
    const metrics = this.accumulator.getMetrics();
    this.evidence = {
      ...this.evidence,
      sessionStepCount: metrics.steps,
      dailyStepCount: metrics.dailySteps,
      pressureHpa: metrics.pressureHpa,
      relativeElevationMeters: metrics.elevationDeltaMeters,
      ascentMeters: metrics.ascentMeters ?? 0,
      descentMeters: metrics.descentMeters ?? 0,
      magneticConfidence: metrics.magneticConfidence,
    };
  }

  private refreshMagneticConfidence() {
    const confidence = calculateMagneticConfidence({
      calibratedFieldMicrotesla: this.evidence.magneticFieldMicrotesla,
      rawFieldMicrotesla: this.evidence.rawMagneticFieldMicrotesla ?? null,
      rawInstabilityMicrotesla:
        this.evidence.magneticFieldInstabilityMicrotesla ?? null,
      compassAccuracy: this.evidence.compassAccuracy,
    });
    this.accumulator.setMagneticConfidence(confidence);
    this.refreshMetrics();
  }

  private markSensorReading(id: keyof SensorAvailability) {
    const now = Date.now();
    this.evidence.activeSensors = {
      ...this.evidence.activeSensors,
      [id]: true,
    };
    this.evidence.sensorReadingsAt = {
      ...this.evidence.sensorReadingsAt,
      [id]: now,
    };
  }

  private addSessionSubscription(
    id: SensorCapabilityId,
    subscribe: () => RemovableSubscription,
  ) {
    try {
      this.subscriptions.push(subscribe());
    } catch {
      sensorCapabilityManager.markTemporaryUnavailable(id);
    }
  }

  private update(values: Partial<SensorEvidence>) {
    this.evidence = {
      ...this.evidence,
      ...values,
      timestamp: Date.now(),
      availability: { ...this.evidence.availability },
    };
    this.refreshMetrics();
    sensorCapabilityManager.publishEvidence(this.evidence);
    const now = Date.now();
    if (
      this.evidenceListener &&
      now - this.lastEvidenceNotificationAt >= 1_000
    ) {
      this.lastEvidenceNotificationAt = now;
      this.evidenceListener(this.cloneEvidence());
    }
  }

  private cloneEvidence(): SensorEvidence {
    return {
      ...this.evidence,
      availability: { ...this.evidence.availability },
      activeSensors: { ...this.evidence.activeSensors },
      sensorReadingsAt: { ...this.evidence.sensorReadingsAt },
    };
  }

  private handleAndroidSensorEvent(event: AndroidSensorEvent) {
    this.nativeLastReadingAt.set(event.id, Date.now());
    this.evidence.availability[event.id] = true;
    this.markSensorReading(event.id);
    const [x = 0, y = 0, z = 0] = event.values;
    switch (event.id) {
      case "proximity": {
        const proximityNear = event.near ?? false;
        const ambientLightLux = this.evidence.ambientLightLux ?? null;
        this.update({
          proximityNear,
          probablePocket: detectProbablePocket(
            ambientLightLux,
            proximityNear,
          ),
        });
        if (ambientLightLux !== null) {
          this.lightListener?.(ambientLightLux, proximityNear);
        }
        break;
      }
      case "gravity":
        this.update({ gravityVectorMps2: { x, y, z } });
        break;
      case "linearAcceleration": {
        const linearAccelerationMps2 = Math.hypot(x, y, z);
        this.update({
          linearAccelerationMps2,
          moving:
            linearAccelerationMps2 >=
            SENSOR_RULES.minimumLinearAccelerationMps2,
        });
        break;
      }
      case "rotationVector":
        this.update({
          rotationVectorHeadingDegrees: event.headingDegrees ?? null,
        });
        break;
      case "gameRotationVector":
        this.update({
          gameRotationVectorHeadingDegrees: event.headingDegrees ?? null,
        });
        break;
      case "geomagneticRotationVector":
        this.update({
          geomagneticRotationVectorHeadingDegrees:
            event.headingDegrees ?? null,
        });
        break;
      case "stepDetector":
        this.update({
          stepDetectorCount: (this.evidence.stepDetectorCount ?? 0) + 1,
          moving: true,
        });
        break;
      case "significantMotion":
        this.update({ significantMotionDetected: true, moving: true });
        break;
    }
  }

  private syncAndroidSensors() {
    const generation = ++this.nativeSyncGeneration;
    this.nativeSyncPromise = this.nativeSyncPromise
      .catch(() => undefined)
      .then(async () => {
        if (generation !== this.nativeSyncGeneration) return;
        this.nativeSubscription?.remove();
        this.nativeSubscription = null;
        if (this.nativeWatchdog) {
          clearInterval(this.nativeWatchdog);
          this.nativeWatchdog = null;
        }
        await stopAndroidSensors().catch(() => undefined);
        if (generation !== this.nativeSyncGeneration) return;

        const ids: AndroidSensorId[] = this.nativeSessionEnabled
          ? [
              "proximity",
              "gravity",
              "linearAcceleration",
              "rotationVector",
              "gameRotationVector",
              "geomagneticRotationVector",
              "stepDetector",
              "significantMotion",
            ]
          : this.nativeProximityEnabled
            ? ["proximity"]
            : [];
        if (ids.length === 0) {
          sensorCapabilityManager.publishNativeRegistered([]);
          return;
        }

        try {
          const result = await startAndroidSensors(
            ids,
            SENSOR_RULES.nativeAndroidSensorIntervalMs,
            (event) => this.handleAndroidSensorEvent(event),
            (event) =>
              sensorCapabilityManager.publishNativeAccuracy(
                event.id,
                event.accuracy,
              ),
          );
          if (generation !== this.nativeSyncGeneration) {
            result?.subscription.remove();
            return;
          }
          if (!result) return;
          this.nativeSubscription = result.subscription;
          const activeIds = new Set(result.activeIds);
          const registeredAt = Date.now();
          for (const id of result.activeIds) {
            this.nativeLastReadingAt.set(id, registeredAt);
          }
          this.evidence.availability = {
            ...this.evidence.availability,
            proximity: activeIds.has("proximity"),
            gravity: activeIds.has("gravity"),
            linearAcceleration: activeIds.has("linearAcceleration"),
            rotationVector: activeIds.has("rotationVector"),
            gameRotationVector: activeIds.has("gameRotationVector"),
            geomagneticRotationVector: activeIds.has(
              "geomagneticRotationVector",
            ),
            stepDetector: activeIds.has("stepDetector"),
            significantMotion: activeIds.has("significantMotion"),
          };
          sensorCapabilityManager.publishNativeRegistered(result.activeIds);
          sensorCapabilityManager.publishEvidence(this.evidence);
          const continuousIds: AndroidSensorId[] = [
            "gravity",
            "linearAcceleration",
            "rotationVector",
            "gameRotationVector",
            "geomagneticRotationVector",
          ];
          this.nativeWatchdog = setInterval(() => {
            const now = Date.now();
            for (const id of continuousIds) {
              if (
                activeIds.has(id) &&
                now - (this.nativeLastReadingAt.get(id) ?? 0) >
                  SENSOR_RULES.nativeContinuousSensorTimeoutMs
              ) {
                if (this.evidence.activeSensors) {
                  this.evidence.activeSensors[id] = false;
                }
                sensorCapabilityManager.markTemporaryUnavailable(id);
              }
            }
          }, SENSOR_RULES.nativeContinuousSensorTimeoutMs / 2);
        } catch {
          for (const id of ids) {
            sensorCapabilityManager.markTemporaryUnavailable(id);
          }
        }
      });
    return this.nativeSyncPromise;
  }

  async start(onEvidence?: EvidenceListener) {
    this.stopSession();
    this.active = true;
    this.evidenceListener = onEvidence ?? null;
    this.accumulator = new SensorSessionAccumulator();
    this.rawMagneticSamples = [];
    this.lastEvidenceNotificationAt = 0;
    this.sessionStartedAt = Date.now();
    const lightAvailable = Boolean(this.evidence.availability.lightSensor);
    this.evidence = emptyEvidence(lightAvailable);
    this.nativeSessionEnabled = true;
    const generation = this.generation;

    let motionPermissionGranted = true;
    try {
      let permission = await DeviceMotion.getPermissionsAsync();
      if (!permission.granted && permission.canAskAgain) {
        permission = await DeviceMotion.requestPermissionsAsync();
      }
      motionPermissionGranted = permission.granted;
    } catch {
      motionPermissionGranted = false;
    }

    let pedometerPermissionGranted = false;
    try {
      let permission = await Pedometer.getPermissionsAsync();
      if (!permission.granted && permission.canAskAgain) {
        permission = await Pedometer.requestPermissionsAsync();
      }
      pedometerPermissionGranted = permission.granted;
    } catch {
      pedometerPermissionGranted = false;
    }

    this.permissionIssues = [
      ...(motionPermissionGranted ? [] : (["motion"] as const)),
      ...(pedometerPermissionGranted ? [] : (["pedometer"] as const)),
    ];
    sensorCapabilityManager.publishPermissionIssues(this.permissionIssues);

    const [
      accelerometer,
      barometer,
      deviceMotion,
      gyroscope,
      magnetometer,
      pedometer,
      uncalibratedMagnetometer,
    ] = await Promise.all([
      motionPermissionGranted
        ? safeAvailability(() => Accelerometer.isAvailableAsync())
        : false,
      safeAvailability(() => Barometer.isAvailableAsync()),
      motionPermissionGranted
        ? safeAvailability(() => DeviceMotion.isAvailableAsync())
        : false,
      motionPermissionGranted
        ? safeAvailability(() => Gyroscope.isAvailableAsync())
        : false,
      motionPermissionGranted
        ? safeAvailability(() => Magnetometer.isAvailableAsync())
        : false,
      pedometerPermissionGranted
        ? safeAvailability(() => Pedometer.isAvailableAsync())
        : false,
      motionPermissionGranted
        ? safeAvailability(() => MagnetometerUncalibrated.isAvailableAsync())
        : false,
    ]);
    if (!this.active || generation !== this.generation) {
      return { ...EMPTY_AVAILABILITY, lightSensor: lightAvailable };
    }

    this.evidence.availability = {
      ...this.evidence.availability,
      accelerometer,
      barometer,
      compass: false,
      deviceMotion,
      gyroscope,
      lightSensor: lightAvailable,
      magnetometer,
      pedometer,
      uncalibratedMagnetometer,
    };
    sensorCapabilityManager.publishDetectedAvailability(
      this.evidence.availability,
    );

    if (accelerometer) {
      this.addSessionSubscription("accelerometer", () => {
        Accelerometer.setUpdateInterval(SENSOR_RULES.updateIntervalMs);
        return Accelerometer.addListener(({ x, y, z }) => {
          this.markSensorReading("accelerometer");
          const accelerationDeltaG = Math.abs(Math.hypot(x, y, z) - 1);
          this.update({
            accelerationDeltaG,
            moving:
              accelerationDeltaG >= SENSOR_RULES.movementAccelerationDeltaG,
          });
        });
      });
    }

    if (gyroscope) {
      this.addSessionSubscription("gyroscope", () => {
        Gyroscope.setUpdateInterval(SENSOR_RULES.updateIntervalMs);
        return Gyroscope.addListener(({ x, y, z }) => {
          this.markSensorReading("gyroscope");
          this.update({ gyroscopeRotationRateRadS: Math.hypot(x, y, z) });
        });
      });
    }

    if (deviceMotion) {
      this.addSessionSubscription("deviceMotion", () => {
        DeviceMotion.setUpdateInterval(SENSOR_RULES.updateIntervalMs);
        return DeviceMotion.addListener(({ rotationRate }) => {
          this.markSensorReading("deviceMotion");
          this.update({
            deviceMotionRotationRateDegS: rotationRate
              ? Math.hypot(
                  rotationRate.alpha,
                  rotationRate.beta,
                  rotationRate.gamma,
                )
              : null,
          });
        });
      });
    }

    if (magnetometer) {
      this.addSessionSubscription("magnetometer", () => {
        Magnetometer.setUpdateInterval(SENSOR_RULES.updateIntervalMs);
        return Magnetometer.addListener(({ x, y, z }) => {
          this.markSensorReading("magnetometer");
          this.evidence.magneticFieldMicrotesla = Math.hypot(x, y, z);
          this.refreshMagneticConfidence();
          this.update({
            magneticFieldMicrotesla: this.evidence.magneticFieldMicrotesla,
          });
        });
      });
    }

    if (uncalibratedMagnetometer) {
      this.addSessionSubscription("uncalibratedMagnetometer", () => {
        MagnetometerUncalibrated.setUpdateInterval(
          SENSOR_RULES.uncalibratedMagnetometerIntervalMs,
        );
        return MagnetometerUncalibrated.addListener(({ x, y, z }) => {
          this.markSensorReading("uncalibratedMagnetometer");
          const magnitude = Math.hypot(x, y, z);
          this.rawMagneticSamples.push(magnitude);
          this.rawMagneticSamples = this.rawMagneticSamples.slice(-5);
          const minimum = Math.min(...this.rawMagneticSamples);
          const maximum = Math.max(...this.rawMagneticSamples);
          this.evidence.rawMagneticFieldMicrotesla = magnitude;
          this.evidence.magneticFieldInstabilityMicrotesla = maximum - minimum;
          this.refreshMagneticConfidence();
          this.update({
            rawMagneticFieldMicrotesla: magnitude,
            magneticFieldInstabilityMicrotesla: maximum - minimum,
          });
        });
      });
    }

    if (barometer) {
      this.addSessionSubscription("barometer", () => {
        Barometer.setUpdateInterval(SENSOR_RULES.barometerIntervalMs);
        return Barometer.addListener(({ pressure, relativeAltitude }) => {
          this.markSensorReading("barometer");
          this.accumulator.updatePressure(pressure, relativeAltitude);
          this.update({});
        });
      });
    }

    if (pedometer) {
      this.addSessionSubscription("pedometer", () =>
        Pedometer.watchStepCount(({ steps }) => {
          this.markSensorReading("pedometer");
          this.accumulator.updateSteps(steps);
          this.update({});
        }),
      );

      if (Platform.OS === "ios") {
        const end = new Date();
        const start = new Date(end);
        start.setHours(0, 0, 0, 0);
        void Pedometer.getStepCountAsync(start, end)
          .then(({ steps }) => {
            if (!this.active || generation !== this.generation) return;
            this.accumulator.updateDailySteps(steps);
            this.update({});
          })
          .catch(() => undefined);
      }
    }

    try {
      const headingSubscription = await Location.watchHeadingAsync(
        (heading) => {
          if (!this.active || generation !== this.generation) return;
          const compassHeadingDegrees =
            heading.trueHeading >= 0 ? heading.trueHeading : heading.magHeading;
          this.markSensorReading("compass");
          this.evidence.availability.compass = true;
          this.evidence.compassAccuracy = heading.accuracy;
          this.refreshMagneticConfidence();
          this.update({
            compassAccuracy: heading.accuracy,
            compassHeadingDegrees,
          });
        },
        () => {
          if (this.evidence.activeSensors) {
            this.evidence.activeSensors.compass = false;
          }
          sensorCapabilityManager.markTemporaryUnavailable("compass");
        },
      );
      if (!this.active || generation !== this.generation) {
        headingSubscription.remove();
      } else {
        this.subscriptions.push(headingSubscription);
      }
    } catch {
      this.evidence.availability.compass = false;
    }

    await this.syncAndroidSensors();
    if (!this.active || generation !== this.generation) {
      return { ...this.evidence.availability };
    }
    this.startSessionWatchdog();
    this.update({});
    return { ...this.evidence.availability };
  }

  async setAmbientLightEnabled(
    enabled: boolean,
    onIlluminance?: (
      illuminanceLux: number,
      proximityNear: boolean | null,
    ) => void,
  ) {
    const requestId = ++this.lightRequestId;

    this.lightSubscription?.remove();
    this.lightSubscription = null;
    this.lightListener = onIlluminance ?? null;
    this.nativeProximityEnabled = enabled;
    void this.syncAndroidSensors();

    if (!enabled) {
      if (this.evidence.activeSensors) {
        this.evidence.activeSensors.lightSensor = false;
      }
      sensorCapabilityManager.publishEvidence(this.evidence);
      this.lightListener = null;
      return false;
    }

    const available = await safeAvailability(() => LightSensor.isAvailableAsync());
    if (requestId !== this.lightRequestId) return false;

    this.evidence.availability.lightSensor = available;
    sensorCapabilityManager.publishDetectedAvailability(
      this.evidence.availability,
    );
    if (!available) return false;

    try {
      LightSensor.setUpdateInterval(SENSOR_RULES.lightSensorIntervalMs);
      this.lightSubscription = LightSensor.addListener(({ illuminance }) => {
        this.markSensorReading("lightSensor");
        this.evidence.ambientLightLux = illuminance;
        const proximityNear = this.evidence.proximityNear ?? null;
        this.evidence.probablePocket = detectProbablePocket(
          illuminance,
          proximityNear,
        );
        this.lightListener?.(illuminance, proximityNear);
        this.update({
          ambientLightLux: illuminance,
          probablePocket: this.evidence.probablePocket,
        });
      });
    } catch {
      sensorCapabilityManager.markTemporaryUnavailable("lightSensor");
      return false;
    }
    return true;
  }

  stopSession(): SensorSessionMetrics {
    this.active = false;
    if (this.sessionWatchdog) {
      clearInterval(this.sessionWatchdog);
      this.sessionWatchdog = null;
    }
    this.nativeSessionEnabled = false;
    void this.syncAndroidSensors();
    this.generation += 1;
    for (const subscription of this.subscriptions) subscription.remove();
    this.subscriptions = [];
    this.evidenceListener = null;
    sensorCapabilityManager.stopSession();
    const metrics = this.accumulator.getMetrics();
    const lightAvailable = Boolean(this.evidence.availability.lightSensor);
    const ambientLightLux = this.evidence.ambientLightLux ?? null;
    this.evidence = {
      ...emptyEvidence(lightAvailable),
      ambientLightLux,
    };
    return metrics;
  }

  stop() {
    this.lightRequestId += 1;

    const metrics = this.stopSession();
    this.lightSubscription?.remove();
    this.lightSubscription = null;
    this.lightListener = null;
    this.nativeProximityEnabled = false;
    void this.syncAndroidSensors();
    if (this.evidence.activeSensors) {
      this.evidence.activeSensors.lightSensor = false;
    }
    sensorCapabilityManager.publishEvidence(this.evidence);
    return metrics;
  }

  getPermissionIssues() {
    return [...this.permissionIssues];
  }

  getEvidence(): SensorEvidence | undefined {
    if (
      !this.active ||
      this.evidence.timestamp === 0 ||
      Date.now() - this.evidence.timestamp > SENSOR_RULES.maximumEvidenceAgeMs
    ) {
      return undefined;
    }
    return this.cloneEvidence();
  }
}
