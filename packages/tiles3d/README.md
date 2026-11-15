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

## Server-side use: what your `fetch` must add

The reader fetches URLs that come from tileset files, which are user input
when the tileset URL is. Its defaults: only `http:` and `https:` are fetched
(`allowedProtocols`), child URIs must share the root tileset's origin
(`allowedOrigins` adds origins, `'*'` allows any), and a response whose final
`url` (after redirects) breaks that policy is discarded. Refusals are `issues`
with `code: 'url-policy'`.

That is a policy on URL text. It cannot see where a host name resolves or
where a redirect leads before the request is made. **A server-side caller (the
CLI, the MCP server, any service) must pass its own `fetch` that:**

- resolves DNS itself and refuses private, loopback and link-local addresses
  (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`,
  `fe80::/10`, and IPv4-mapped forms), then connects to the resolved address it
  checked (pinned), so a second lookup cannot return a different one;
- handles redirects manually (`redirect: 'manual'`) and re-checks every hop
  against the same rules and the URL policy.

This package does not do DNS pinning.

## What it reads

- **Traversal.** 3D Tiles 1.0 and 1.1 tileset JSON. External tilesets are followed and cycles are reported. A child is recognised as an external tileset by its content (tileset JSON), whatever its URL ends in. Relative and same-origin child URIs inherit the parent's query parameters as CesiumJS does, the child's own parameters winning on conflict; parameters are never carried to another origin. Bounding volumes `region`, `box` and `sphere` are culled against the region, with tile `transform`s composed parent times child. Regions ignore transforms, as the specification says. `ADD` refinement collects every intersecting content down to `maxGeometricError` (default 0, the leaves). `REPLACE` selects the level that meets it. Implicit tiling and unknown bounding-volume extensions are reported as unsupported.
- **Content.** b3dm (including legacy headers), with the feature table (`BATCH_LENGTH`, `RTC_CENTER`), the batch table (JSON plus binary body) and the embedded glTF 2.0. glb and glTF JSON content (3D Tiles 1.1) is read too. Geometry may use `KHR_draco_mesh_compression` or `KHR_mesh_quantization`. Node transforms, the glTF y-up to z-up rotation, `RTC_CENTER` and `CESIUM_RTC` are all applied. Features are split by `_BATCHID`, or by `EXT_mesh_features` attribute feature ids. `EXT_structural_metadata` properties are not read, and a warning says so. i3dm, pnts, cmpt and implicit subtrees are reported as unsupported.
- **Output.** One `FeatureMesh` per feature. It holds float64 `positions` in the tileset root frame, `indices` and unit `normals`. `groups` holds one triangle range per glTF primitive, with its material index, name and base colour. `attributes` holds the batch table row, and `tile` its provenance: URL, tileset chain and versions.

No height datum is interpreted. Positions are what the tileset encodes, so a
caller converts them with a CRS package (`ecefToGeodetic` gives WGS84 lon, lat
and ellipsoidal height to chain from).

## Budgets, failures and partial results

- `maxRequests` (default 200) and `maxBytes` (default 64 MiB) bound network use. Cache hits are free. Bytes are counted as `fetch` hands them over, that is after transport decompression: a gzip-encoded subtree counts at its decompressed size. A response body is read as a stream and stopped as soon as it would cross the remaining budget, so neither one endless body nor several concurrent ones can overshoot it. `Content-Length` is not trusted for this: it is the encoded transfer size and can exceed the decoded size of a small gzip response. (A custom `fetch` whose responses have no `body` stream is read whole and then checked, which bounds the count but not the memory of that one response.)
- Decoding is bounded too: `maxVerticesPerContent` (default 2,000,000), `maxIndicesPerContent` (6,000,000), `maxDecodedVertices` (8,000,000) and `maxDecodedIndices` (24,000,000) cap the decoded geometry per tile content and per query, Draco output included. Counts are checked from the glTF accessors before anything is decoded. Every count, length and offset a file declares (BATCH_LENGTH, accessor counts and byte ranges, strides, tile depth with `maxDepth`, default 256) is validated against the bytes present or a budget before it is allocated.
- When a budget stops the query, the result has `truncated: true`, `truncation.reason` (`requests`, `bytes`, `nodes` or `decoded`) and `truncation.pendingUrls` lists what was not fetched or decoded. Everything already fetched is still returned.
- A failed request, a timeout (`timeoutMs`, default 30 s) or an undecodable tile becomes an `issues` entry, and the query continues. Refused input carries a `code`: `limit` (a declared size exceeds a limit or what the bytes can hold), `invalid-content` (malformed: negative offsets, a stride shorter than its element, float indices, ...), `url-policy`, or `missing-attributes` (swisstopo preset). `complete` is true only when nothing was truncated and there are no `error` or `unsupported` issues.
- It throws only for an invalid region or option, an unloadable root tileset (including a root URL the URL policy refuses), or an aborted `signal`.
- Inject `fetch` (any `(url, { signal, headers }) => Promise<{ ok, status, body?, headers?, url?, arrayBuffer() }>`; the global `fetch` fits) and a `cache` (`get` / `set` by URL, for tileset JSON and content alike).
- Batch table rows are plain objects whose keys are own data properties: a column named `__proto__`, `constructor` or `prototype` stays data and never changes a prototype.
- `tileCullMarginMetres` grows the region for tile culling only. Use it for tilesets whose bounding volumes do not enclose their content (see below).

## Draco decoder

Draco decoding uses Google's [`draco3d`](https://www.npmjs.com/package/draco3d)
1.5.7, under the Apache-2.0 licence. Only its decoder module is imported
(about 59 KB of JavaScript plus a 286 KB wasm), never the encoder. It is
loaded lazily, the first time a Draco primitive is met, and one instance is
shared by every query in the process. In Node it finds its wasm by itself.

A browser bundle must tell it where the wasm is, or the decoder requests it
relative to the page and gets a 404. This package exports the wasm, so the app
needs no `draco3d` dependency of its own. With Vite:

```js
// Vite's ?url import (not a TypeScript sample: it needs vite/client types)
import dracoWasmUrl from '@ifc-lite/tiles3d/draco_decoder.wasm?url';
const result = await readTilesetRegion({ url, region, dracoModuleOptions: { locateFile: () => dracoWasmUrl } });
```

`{ wasmBinary }` or your own `loadDraco` work too. The options of the first
load apply until `resetDracoDecoder()`. A failed load is cached, so a wrong
wasm URL is reported for each Draco tile without being fetched again for
each; call `resetDracoDecoder()` to retry. Draco's own allocation during
decoding happens inside the wasm heap, which draco3d caps at 2 GiB.

## swisstopo swissBUILDINGS3D notes

These were measured on release `20260520` with `scripts/live-smoke.mjs`.

- Heights, an observed property of this dataset rather than of 3D Tiles: every tile measured on release 20260520 stores the same heights as its `DACH_MAX` attribute (Swiss national heights, LN02) in the slot 3D Tiles reserves for WGS84 ellipsoidal height. Evidence: each tile's `RTC_CENTER` lies at ellipsoidal height 0, and each building's decoded top equals its `DACH_MAX` to 0.01 m, where a true ellipsoidal height would be about 50 m higher. Tile region heights match terrain heights too. The reader returns the coordinates as stored; convert them with a CRS package.
- Leaf tiles hold the buildings whose centre lies in the tile region, and buildings overhang it by up to 84 m in the tiles measured. The preset culls with a 100 m margin (`SWISSTOPO_TILE_CULL_MARGIN_METRES`), then filters features by their own footprint. **The 100 m is a measured value, not a bound:** a building larger than about 200 m across can overhang its tile by more than 100 m, and a query that only touches its overhanging part misses it without any issue. Pass a larger `tileCullMarginMetres` where such buildings matter (it costs requests).
- Batch table columns vary by region. Bern, Zürich and Uri tiles carry `EGID`, `GELAENDEPUNKT`, `DACH_MIN` and `DACH_MAX`. The measured Geneva and Ticino tiles carry none of them, so the preset adds a `warning` issue with `code: 'missing-attributes'` for every tile that lacks any of them. Some columns are shorter than `BATCH_LENGTH`, and the reader reports this as a warning.
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
