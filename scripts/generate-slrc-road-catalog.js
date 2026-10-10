const fs = require("node:fs/promises");
const path = require("node:path");

const ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];
const BOUNDS = { south: 32.4, west: -114.8334, north: 32.5, east: -114.7 };
const ROWS = 4;
const COLUMNS = 4;
const EXCLUDED = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link",
  "construction", "proposed", "raceway",
]);

const nodeId = (point) => `${point.latitude.toFixed(6)}:${point.longitude.toFixed(6)}`;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchTile(bounds, attempt = 1) {
  const query = `[out:json][timeout:90];way["highway"](${bounds.south},${bounds.west},${bounds.north},${bounds.east});out tags geom;`;
  try {
    const response = await fetch(ENDPOINTS[(attempt - 1) % ENDPOINTS.length], {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": "PaintFoot.io-school-project/1.0",
      },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).elements ?? [];
  } catch (error) {
    if (attempt >= 8) throw error;
    await wait(attempt * 2_000);
    return fetchTile(bounds, attempt + 1);
  }
}

async function main() {
  const ways = new Map();
  const latitudeStep = (BOUNDS.north - BOUNDS.south) / ROWS;
  const longitudeStep = (BOUNDS.east - BOUNDS.west) / COLUMNS;
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const tile = {
        south: BOUNDS.south + row * latitudeStep,
        north: BOUNDS.south + (row + 1) * latitudeStep,
        west: BOUNDS.west + column * longitudeStep,
        east: BOUNDS.west + (column + 1) * longitudeStep,
      };
      const elements = await fetchTile(tile);
      for (const element of elements) {
        if (
          element.type !== "way" ||
          !Array.isArray(element.geometry) ||
          element.geometry.length < 2 ||
          EXCLUDED.has(element.tags?.highway ?? "") ||
          element.tags?.access === "private" ||
          element.tags?.foot === "no"
        ) continue;
        const current = ways.get(element.id);
        if (!current || element.geometry.length > current.geometry.length) {
          ways.set(element.id, element);
        }
      }
      process.stdout.write(`Calles OSM: ${ways.size}\r`);
      await wait(350);
    }
  }

  const segments = [...ways.values()].map((way) => {
    const coordinates = way.geometry.map((point) => ({
      latitude: Number(point.lat.toFixed(6)),
      longitude: Number(point.lon.toFixed(6)),
    }));
    return {
      id: `osm-way-${way.id}`,
      wayId: String(way.id),
      name: way.tags?.name ?? null,
      coordinates,
      startNodeId: nodeId(coordinates[0]),
      endNodeId: nodeId(coordinates[coordinates.length - 1]),
      intersectingEdgeCount: 2,
      endNodeType: way.tags?.junction ?? null,
    };
  });
  const output = path.join(__dirname, "..", "assets", "data", "slrc-walkable-roads.json");
  await fs.writeFile(output, JSON.stringify(segments));
  process.stdout.write(`\nGuardadas ${segments.length} calles en ${output}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
