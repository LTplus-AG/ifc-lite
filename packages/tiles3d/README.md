# @ifc-lite/tiles3d

Headless reader for OGC 3D Tiles. Give it a tileset URL and a small WGS84
region, and it returns the features inside that region as meshes with their
attributes. It runs in Node and in the browser, and renders nothing.

It was built to bring neighbouring buildings into a BIM model as data. The
first consumer is swisstopo's hosted swissBUILDINGS3D tileset, which has a
preset here.

## Installation

```bash
npm install @ifc-lite/tiles3d
```

## Usage

```ts
import { readTilesetRegion, ecefToGeodetic } from '@ifc-lite/tiles3d';

const result = await readTilesetRegion({
  url: 'https://example.com/tileset.json',
  region: { west: 7.4385, south: 46.9512, east: 7.4399, north: 46.9519 }, // degrees
  maxRequests: 40,
});

if (!result.complete) console.warn(result.truncation, result.issues);
for (const feature of result.features) {
  // positions: Float64Array in the tileset root frame (ECEF metres for a geospatial tileset)
  const [x, y, z] = feature.positions;
  const { lon, lat, height } = ecefToGeodetic(x, y, z);
  console.log(feature.featureId, feature.attributes, lon, lat, height, feature.groups);
}
```

swisstopo buildings, with the attribution you must display:

```ts
import { readSwisstopoBuildings } from '@ifc-lite/tiles3d';

const buildings = await readSwisstopoBuildings({
  region: { west: 7.4385, south: 46.9512, east: 7.4399, north: 46.9519 },
  release: '20260520', // optional: pin a dated release
});
console.log(buildings.attribution, buildings.features.map((f) => f.attributes.EGID));
```

## What it reads

- **Traversal.** 3D Tiles 1.0 and 1.1 tileset JSON. External tilesets are followed and cycles are reported. Bounding volumes `region`, `box` and `sphere` are culled against the region, with tile `transform`s composed parent times child. Regions ignore transforms, as the specification says. `ADD` refinement collects every intersecting content down to `maxGeometricError` (default 0, the leaves). `REPLACE` selects the level that meets it. Implicit tiling and unknown bounding-volume extensions are reported as unsupported.
- **Content.** b3dm (including legacy headers), with the feature table (`BATCH_LENGTH`, `RTC_CENTER`), the batch table (JSON plus binary body) and the embedded glTF 2.0. glb and glTF JSON content (3D Tiles 1.1) is read too. Geometry may use `KHR_draco_mesh_compression` or `KHR_mesh_quantization`. Node transforms, the glTF y-up to z-up rotation, `RTC_CENTER` and `CESIUM_RTC` are all applied. Features are split by `_BATCHID`, or by `EXT_mesh_features` attribute feature ids. `EXT_structural_metadata` properties are not read, and a warning says so. i3dm, pnts, cmpt and implicit subtrees are reported as unsupported.
- **Output.** One `FeatureMesh` per feature. It holds float64 `positions` in the tileset root frame, `indices` and unit `normals`. `groups` holds one triangle range per glTF primitive, with its material index, name and base colour. `attributes` holds the batch table row, and `tile` its provenance: URL, tileset chain and versions.

No height datum is interpreted. Positions are what the tileset encodes, so a
caller converts them with a CRS package (`ecefToGeodetic` gives WGS84 lon, lat
and ellipsoidal height to chain from).

## Budgets, failures and partial results

- `maxRequests` (default 200) and `maxBytes` (default 64 MiB) bound network use. Cache hits are free. When a budget stops the query, the result has `truncated: true` and `truncation.pendingUrls` lists what was not fetched. Everything already fetched is still returned.
- A failed request, a timeout (`timeoutMs`, default 30 s) or an undecodable tile becomes an `issues` entry, and the query continues. `complete` is true only when nothing was truncated and there are no `error` or `unsupported` issues.
- It throws only for an invalid region, an unloadable root tileset, or an aborted `signal`.
- Inject `fetch` (any `(url, { signal, headers }) => Promise<{ ok, status, arrayBuffer() }>`) and a `cache` (`get` / `set` by URL, for tileset JSON and content alike).
- `tileCullMarginMetres` grows the region for tile culling only. Use it for tilesets whose bounding volumes do not enclose their content (see below).

## Draco decoder

Draco decoding uses Google's [`draco3d`](https://www.npmjs.com/package/draco3d)
1.5.7, under the Apache-2.0 licence. The decoder is about 59 KB of JavaScript
plus a 286 KB wasm. It is loaded lazily, the first time a Draco primitive is
met. In Node it finds its wasm by itself. In a browser bundle, pass
`dracoModuleOptions: { locateFile: () => wasmUrl }` (or `{ wasmBinary }`), or
pass your own `loadDraco`.

## swisstopo swissBUILDINGS3D notes

These were measured on release `20260520` with `scripts/live-smoke.mjs`.

- Heights are stored as Swiss national heights, in the slot that 3D Tiles reserves for WGS84 ellipsoidal height. Every tile's `RTC_CENTER` is at ellipsoidal height 0. The decoded top of each building equals its `DACH_MAX` attribute to the centimetre, and tile region heights match terrain heights. A true ellipsoidal height would be about 50 m higher. The reader returns the coordinates as stored.
- Leaf tiles hold the buildings whose centre lies in the tile region, and buildings overhang it by up to 84 m. The preset therefore culls with a 100 m margin (`SWISSTOPO_TILE_CULL_MARGIN_METRES`), then filters features by their own footprint.
- Batch table columns vary by region. Bern, Zürich and Uri tiles carry `EGID`, `GELAENDEPUNKT`, `DACH_MIN` and `DACH_MAX`. The measured Geneva and Ticino tiles carry none of them. Some columns are shorter than `BATCH_LENGTH`, and the reader reports this as a warning.
- Each tile has two primitives: a beige wall material and a red roof material. Both are `doubleSided`, and triangle winding is not consistent.
- Data: © swisstopo. Free use with mandatory source reference; excessive use may be restricted.

## Live smoke test

The live smoke test is opt-in and never runs in CI. It makes about 110 requests,
mostly for large subtree JSON, and stores the responses on disk, so a re-run is free.

```bash
pnpm --filter @ifc-lite/tiles3d smoke:live
```

## License

MPL-2.0
