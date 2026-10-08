export const TRACKING_RULES = {
  maxGpsAccuracyMeters: 20,
  minimumPointDistanceMeters: 3,
  maxAcceptableSpeedMps: 10,
} as const;

export const ROAD_MATCHING_RULES = {
  endpoint:
    process.env.EXPO_PUBLIC_MAP_MATCHING_URL?.trim() ||
    "https://valhalla1.openstreetmap.de/trace_attributes",
  batchPointCount: 4,
  minimumRequestIntervalMs: 4_000,
  maxRawPointsPerRequest: 120,
  overlapRawPoints: 8,
  searchRadiusMeters: 35,
  maximumUnmatchedRatio: 0.25,
  mergeToleranceMeters: 40,
  requestTimeoutMs: 12_000,
} as const;

export const SENSOR_RULES = {
  updateIntervalMs: 200,
  uncalibratedMagnetometerIntervalMs: 500,
  barometerIntervalMs: 1_000,
  lightSensorIntervalMs: 1_000,
  maximumEvidenceAgeMs: 3_000,
  minimumMovementSpeedMps: 0.7,
  minimumCompassAccuracy: 1,
  maximumCompassGpsDifferenceDegrees: 45,
  significantGpsTurnDegrees: 50,
  significantGyroscopeRateRadS: 0.45,
  significantDeviceMotionRateDegS: 25,
  movementAccelerationDeltaG: 0.06,
  minimumLinearAccelerationMps2: 0.6,
  minimumMagneticFieldMicrotesla: 20,
  maximumMagneticFieldMicrotesla: 100,
  maximumMagneticFieldDifferenceMicrotesla: 18,
  maximumMagneticFieldInstabilityMicrotesla: 10,
  barometerSmoothingFactor: 0.2,
  minimumElevationChangeMeters: 1.5,
  lightAverageSampleCount: 5,
  lightToDarkThresholdLux: 30,
  darkToLightThresholdLux: 120,
  lightConditionHoldMs: 5_000,
  pocketMaximumLightLux: 5,
  nativeAndroidSensorIntervalMs: 200,
  nativeContinuousSensorTimeoutMs: 10_000,
  suspiciousDistanceWithoutStepsMeters: 500,
  straightTurnPenaltyFactor: 500,
  confirmedTurnPenaltyFactor: 150,
  maximumProtectedParallelJumpMeters: 12,
  transitionScoreMargin: 1,
  weights: {
    gpsDistance: 0.8,
    heading: 8,
    roadContinuity: 10,
    confirmedTurn: 14,
  },
} as const;

export const TERRITORY_RULES = {
  closureToleranceMeters: 15,
  minimumAreaM2: 200,
  minimumRouteDistanceMeters: 70,
  minimumDistinctPoints: 3,
  // No existe un area maxima: el tamano no invalida un perimetro recorrido.
} as const;

export const MAX_SHIELD_DURATION_HOURS = 36;
export const SHIELD_WARNING_PERCENTAGE = 0.3;
export const FREE_SHIELD_DURATION_HOURS = 1;
export const FREE_SHIELD_COOLDOWN_HOURS = 24;
export const PAID_SHIELD_DURATION_HOURS = [1, 6, 12, 24, 36] as const;

export const SHIELD_RULES = {
  maximumDurationHours: MAX_SHIELD_DURATION_HOURS,
  warningPercentage: SHIELD_WARNING_PERCENTAGE,
  freeDurationHours: FREE_SHIELD_DURATION_HOURS,
  freeCooldownHours: FREE_SHIELD_COOLDOWN_HOURS,
  paidDurationHours: PAID_SHIELD_DURATION_HOURS,
  millisecondsPerHour: 60 * 60 * 1_000,
} as const;

export const STORAGE_RULES = {
  maximumTerritories: 500,
} as const;

export const GLOBAL_MULTIPLAYER_RULES = {
  captureRule: "full_perimeter_required",
  presencePublishIntervalMs: 3_000,
  presencePersistenceIntervalMs: 3_000,
  presenceMaximumAgeMs: 30_000,
  territoryPageSize: 200,
  maximumTerritoryPages: 5,
  regionSubscriptionRadius: 1,
  maximumActiveRegionalChannels: 9,
} as const;
