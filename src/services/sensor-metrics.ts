import { SENSOR_RULES } from "../config/territory";
import type {
  ConfidenceLevel,
  ResolvedTheme,
  SensorSessionMetrics,
  ThemePreference,
} from "../types/game";

export function confidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.75) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}

export function pressureToRelativeAltitudeMeters(
  pressureHpa: number,
  baselinePressureHpa: number,
) {
  if (pressureHpa <= 0 || baselinePressureHpa <= 0) return 0;
  return 44_330 * (1 - (pressureHpa / baselinePressureHpa) ** (1 / 5.255));
}

export class SensorSessionAccumulator {
  private steps: number | null = null;
  private dailySteps: number | null = null;
  private baselinePressureHpa: number | null = null;
  private filteredPressureHpa: number | null = null;
  private currentElevationMeters: number | null = null;
  private acceptedElevationMeters: number | null = null;
  private ascentMeters = 0;
  private descentMeters = 0;
  private magneticConfidence: ConfidenceLevel = "medium";

  updateSteps(steps: number) {
    this.steps = Math.max(this.steps ?? 0, Math.max(0, Math.round(steps)));
  }

  updateDailySteps(steps: number) {
    this.dailySteps = Math.max(0, Math.round(steps));
  }

  updatePressure(pressureHpa: number, relativeAltitude?: number) {
    if (!Number.isFinite(pressureHpa) || pressureHpa <= 0) return;
    this.baselinePressureHpa ??= pressureHpa;
    this.filteredPressureHpa =
      this.filteredPressureHpa === null
        ? pressureHpa
        : this.filteredPressureHpa *
            (1 - SENSOR_RULES.barometerSmoothingFactor) +
          pressureHpa * SENSOR_RULES.barometerSmoothingFactor;

    const elevation =
      relativeAltitude !== undefined && Number.isFinite(relativeAltitude)
        ? relativeAltitude
        : pressureToRelativeAltitudeMeters(
            this.filteredPressureHpa,
            this.baselinePressureHpa,
          );
    this.currentElevationMeters = elevation;
    if (this.acceptedElevationMeters === null) {
      this.acceptedElevationMeters = elevation;
      return;
    }

    const change = elevation - this.acceptedElevationMeters;
    if (Math.abs(change) < SENSOR_RULES.minimumElevationChangeMeters) return;
    if (change > 0) this.ascentMeters += change;
    else this.descentMeters += Math.abs(change);
    this.acceptedElevationMeters = elevation;
  }

  setMagneticConfidence(confidence: ConfidenceLevel) {
    this.magneticConfidence = confidence;
  }

  getMetrics(): SensorSessionMetrics {
    return {
      steps: this.steps,
      dailySteps: this.dailySteps,
      pressureHpa: this.filteredPressureHpa,
      elevationDeltaMeters: this.currentElevationMeters,
      ascentMeters:
        this.filteredPressureHpa === null ? null : this.ascentMeters,
      descentMeters:
        this.filteredPressureHpa === null ? null : this.descentMeters,
      magneticConfidence: this.magneticConfidence,
    };
  }
}

export function calculateMagneticConfidence({
  calibratedFieldMicrotesla,
  rawFieldMicrotesla,
  rawInstabilityMicrotesla,
  compassAccuracy,
}: {
  calibratedFieldMicrotesla: number | null;
  rawFieldMicrotesla: number | null;
  rawInstabilityMicrotesla: number | null;
  compassAccuracy: number | null;
}): ConfidenceLevel {
  if (rawFieldMicrotesla === null) {
    return compassAccuracy !== null && compassAccuracy >= 2
      ? "high"
      : compassAccuracy !== null && compassAccuracy >= 1
        ? "medium"
        : "low";
  }

  const rawFieldNormal =
    rawFieldMicrotesla >= SENSOR_RULES.minimumMagneticFieldMicrotesla &&
    rawFieldMicrotesla <= SENSOR_RULES.maximumMagneticFieldMicrotesla;
  const stable =
    rawInstabilityMicrotesla === null ||
    rawInstabilityMicrotesla <=
      SENSOR_RULES.maximumMagneticFieldInstabilityMicrotesla;
  const calibratedDifferenceNormal =
    calibratedFieldMicrotesla === null ||
    Math.abs(rawFieldMicrotesla - calibratedFieldMicrotesla) <=
      SENSOR_RULES.maximumMagneticFieldDifferenceMicrotesla;

  if (
    rawFieldNormal &&
    stable &&
    calibratedDifferenceNormal &&
    compassAccuracy !== null &&
    compassAccuracy >= 2
  ) {
    return "high";
  }
  if (
    rawFieldNormal &&
    stable &&
    compassAccuracy !== null &&
    compassAccuracy >= 1
  ) {
    return "medium";
  }
  return "low";
}

export function detectProbablePocket(
  illuminanceLux: number | null,
  proximityNear: boolean | null,
) {
  return (
    proximityNear === true &&
    illuminanceLux !== null &&
    illuminanceLux <= SENSOR_RULES.pocketMaximumLightLux
  );
}

export class AmbientThemeController {
  private samples: number[] = [];
  private candidate: ResolvedTheme | null = null;
  private candidateSince = 0;
  private resolvedTheme: ResolvedTheme;

  constructor(initialTheme: ResolvedTheme = "dark") {
    this.resolvedTheme = initialTheme;
  }

  update(
    preference: ThemePreference,
    illuminanceLux: number,
    timestamp = Date.now(),
    proximityNear: boolean | null = null,
  ): ResolvedTheme {
    if (preference !== "auto") {
      this.candidate = null;
      this.samples = [];
      this.resolvedTheme = preference;
      return this.resolvedTheme;
    }

    if (!Number.isFinite(illuminanceLux) || illuminanceLux < 0) {
      return this.resolvedTheme;
    }
    if (detectProbablePocket(illuminanceLux, proximityNear)) {
      this.candidate = null;
      return this.resolvedTheme;
    }
    this.samples.push(illuminanceLux);
    this.samples = this.samples.slice(-SENSOR_RULES.lightAverageSampleCount);
    const average =
      this.samples.reduce((total, value) => total + value, 0) /
      this.samples.length;
    const desired =
      this.resolvedTheme === "dark"
        ? average >= SENSOR_RULES.darkToLightThresholdLux
          ? "light"
          : "dark"
        : average <= SENSOR_RULES.lightToDarkThresholdLux
          ? "dark"
          : "light";

    if (desired === this.resolvedTheme) {
      this.candidate = null;
      return this.resolvedTheme;
    }
    if (this.candidate !== desired) {
      this.candidate = desired;
      this.candidateSince = timestamp;
      return this.resolvedTheme;
    }
    if (timestamp - this.candidateSince >= SENSOR_RULES.lightConditionHoldMs) {
      this.resolvedTheme = desired;
      this.candidate = null;
    }
    return this.resolvedTheme;
  }
}
