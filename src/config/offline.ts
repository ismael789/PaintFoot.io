export const REGIONAL_CACHE_CONFIG = {
  maxBytes: 200 * 1024 * 1024,
  maxRegions: 500,
  ttlMs: 30 * 24 * 60 * 60 * 1_000,
  regionDegrees: 0.02,
  neighborRadius: 1,
  prefetchEdgeRatio: 0.2,
  lowStorageThresholdBytes: 500 * 1024 * 1024,
  overpassEndpoint: "https://overpass-api.de/api/interpreter",
} as const;

