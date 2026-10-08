import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";

import { getAppSpecificExternalFilesUri } from "@/services/monotonic-clock";
import type { RoadSegment } from "@/types/game";

const DATA_DIRECTORY_NAME = "paintfoot-data";
const ROAD_CACHE_DIRECTORY_NAME = "road-cache";

export interface RoadCacheBlockWriteResult {
  relativePath: string;
  sizeBytes: number;
  contentHash: string;
}

function primaryStorageRoot() {
  const externalUri = getAppSpecificExternalFilesUri();
  return externalUri ? new Directory(externalUri) : Paths.document;
}

function dataDirectory(root = primaryStorageRoot()) {
  return new Directory(root, DATA_DIRECTORY_NAME);
}

function roadCacheDirectory(root = primaryStorageRoot()) {
  return new Directory(dataDirectory(root), ROAD_CACHE_DIRECTORY_NAME);
}

function ensureRoadCacheDirectory() {
  const root = dataDirectory();
  if (!root.exists) root.create({ idempotent: true, intermediates: true });
  const roadCache = roadCacheDirectory();
  if (!roadCache.exists) {
    roadCache.create({ idempotent: true, intermediates: true });
  }
  return roadCache;
}

function safeRegionName(regionId: string) {
  return regionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function blockFile(regionId: string, root = primaryStorageRoot()) {
  return new File(
    root.uri === primaryStorageRoot().uri
      ? ensureRoadCacheDirectory()
      : roadCacheDirectory(root),
    `${safeRegionName(regionId)}.json`,
  );
}

async function sha256(contents: string) {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    contents,
  );
}

export async function writeRoadCacheBlock(
  regionId: string,
  segments: RoadSegment[],
): Promise<RoadCacheBlockWriteResult> {
  const contents = JSON.stringify({ version: 1, regionId, segments });
  const file = blockFile(regionId);
  file.write(contents);
  const contentHash = await sha256(contents);
  return {
    relativePath: `${ROAD_CACHE_DIRECTORY_NAME}/${file.name}`,
    sizeBytes: file.size,
    contentHash,
  };
}

export async function readRoadCacheBlock(
  regionId: string,
  expectedHash?: string,
): Promise<RoadSegment[] | null> {
  let file = blockFile(regionId);
  if (!file.exists && primaryStorageRoot().uri !== Paths.document.uri) {
    const legacy = blockFile(regionId, Paths.document);
    if (legacy.exists) {
      const legacyContents = await legacy.text();
      const legacyHash = await sha256(legacyContents);
      if (!expectedHash || legacyHash === expectedHash) {
        file.write(legacyContents);
        const migratedContents = await file.text();
        if ((await sha256(migratedContents)) === legacyHash) legacy.delete();
      }
    }
  }
  if (!file.exists) return null;
  try {
    const contents = await file.text();
    if (expectedHash) {
      const actualHash = await sha256(contents);
      if (actualHash !== expectedHash) return null;
    }
    const parsed = JSON.parse(contents) as {
      version?: number;
      regionId?: string;
      segments?: RoadSegment[];
    };
    return parsed.version === 1 && Array.isArray(parsed.segments)
      ? parsed.segments
      : null;
  } catch {
    return null;
  }
}

export function deleteRoadCacheBlock(regionId: string) {
  const file = blockFile(regionId);
  if (file.exists) file.delete();
}

export function clearRoadCacheFiles() {
  const directories = [roadCacheDirectory()];
  if (primaryStorageRoot().uri !== Paths.document.uri) {
    directories.push(roadCacheDirectory(Paths.document));
  }
  for (const directory of directories) {
    if (directory.exists) directory.delete();
  }
}

export function getRoadCacheFilesSize() {
  const primary = roadCacheDirectory();
  const legacy = roadCacheDirectory(Paths.document);
  return (
    (primary.exists ? (primary.size ?? 0) : 0) +
    (primary.uri !== legacy.uri && legacy.exists ? (legacy.size ?? 0) : 0)
  );
}

export function getLargeFileStorageKind() {
  return getAppSpecificExternalFilesUri()
    ? "android_app_specific_external"
    : "expo_document";
}

export function getAvailableStorageBytes() {
  return Paths.availableDiskSpace;
}

