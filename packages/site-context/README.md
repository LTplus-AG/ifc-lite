# @ifc-lite/site-context

The site around a georeferenced Swiss building, as data: real terrain
(**swissALTI3D**), the cadastral **parcel** and the neighbouring
**buildings** (**swissBUILDINGS3D**), in one local frame stated in
**EPSG:2056 (LV95)** and **EPSG:5728 (LN02 heights)**, written as one
self-describing GLB. Headless (browser and Node). The viewer, the CLI and
the MCP server build on the same core.

```ts
import { createSwissGeodata } from '@ifc-lite/geodata-ch';
import { buildSiteContext, encodeSiteContextGlb, decodeSiteContextGlb } from '@ifc-lite/site-context';

const doc = await buildSiteContext({
  centre: { x: 2_600_423, y: 1_199_521 }, // EPSG:2056, easting first
  radius: 150,                            // metres: the site is the square centre ± radius
  layers: ['terrain', 'parcel'],
  resolution: 'auto',
  geodata: createSwissGeodata(),          // injected: one rate limit, one cache
});
const glb = encodeSiteContextGlb(doc);    // Uint8Array, opens in any glTF viewer
const same = decodeSiteContextGlb(glb);   // the document again, exactly
```

From the command line: `ifc-lite site-context model.ifc --radius 300 --out context.glb --json`
(see the [CLI guide](https://ifclite.dev/docs/guide/site-context/)).

## Attribution is required

Every layer carries the `attribution` the data owners require
(`Attribution[]` from `@ifc-lite/geodata-ch`, verbatim), and the GLB carries
it too. **Show it wherever the context is shown.**

| Layer | Show | Terms |
|---|---|---|
| terrain | `© swisstopo` | swisstopo OGD: free use including commercial, source reference mandatory |
| parcel | `© Cadastral surveying (CS) and the cantons` | **Not verified.** The cantons own the data; the terms page geocat points to returned 404. Check the canton's terms before redistributing parcel geometry. The parcel layer always carries a `terms-unverified` issue saying so. |
| parcel (ÖREB link) | `© swisstopo` | ÖREB availability register, no restriction stated |
| buildings | `© swisstopo (swissBUILDINGS3D)` | swisstopo OGD, as terrain; the text comes from the `@ifc-lite/tiles3d` swisstopo preset |

The FSDI fair-use terms apply to every geo.admin.ch request.

## API

### `buildSiteContext(options): Promise<SiteContextDocument>`

| Option | Meaning |
|---|---|
| `centre` | `{ x, y }` in EPSG:2056. Outside the Swiss coverage → `SiteContextCoverageError`, before any request. |
| `radius` | Half the side of the square site, in metres (0 < r ≤ 5000). |
| `layers` | `'terrain' \| 'parcel' \| 'buildings'`. |
| `resolution` | Terrain node spacing in metres, or `'auto'` (default): `max(0.5, extent / 500)` rounded up to 1/16 m, where `extent = 2 · radius`. That keeps the terrain near 501 × 501 nodes (≈ 250 000 vertices, 500 000 triangles): 200 m → 0.5 m, 500 m → 1 m, 1 km → 2 m. The rounding makes every node coordinate exact in float32, so chunk seams are bit-identical. Grids over 4 000 000 nodes are refused. |
| `subject` | `{ footprint?, egid?, egrid? }`: `egrid` takes the parcel by EGRID; otherwise the parcel is the one at the footprint's centroid, or at the centre. In the buildings layer the model's own building is marked `subject: true` (every object of it when the tiles split it, kept past the caps): the one whose `EGID` equals `egid`, else the one whose footprint overlaps `footprint` (EPSG:2056 rings, outer first) by at least `SUBJECT_MIN_OVERLAP` (0.5) of the smaller of the two areas. |
| `buildings` | `BuildingsOptions`: `reader` (default `readSwisstopoBuildings` of `@ifc-lite/tiles3d`), `fetch` and `cache` passed to it (the CLI's on-disk cache, the viewer's own), `release`, `maxRequests` / `maxBytes` (preset defaults 64 / 32 MiB), `tileCullMarginMetres` (preset 100 m), `dracoModuleOptions` (a browser's `locateFile` for `@ifc-lite/tiles3d/draco_decoder.wasm`), and the caps `maxFeatures` (5000) and `maxTriangles` (2 000 000). |
| `geodata` | A `SwissGeodata` from `@ifc-lite/geodata-ch` (or anything with its `elevationGrid`, `parcelById`, `parcelsAtPoint`, `oerebExtract`). |
| `signal`, `onProgress`, `onLayer` | Abort; progress messages; each finished layer in document order. |

It also exports `summarizeSiteContext(doc)` (per-layer feature, triangle and
vertex counts, parcels with their ÖREB link, and for buildings the count,
how many have an EGID, the subject and its match, tile requests and bytes,
triangles per part), the constants `BUILDING_SET` and
`SUBJECT_MIN_OVERLAP`, and the error classes
`SiteContextCoverageError` and `SiteContextFormatError`.

### `swisstopoOnlyFetch(inner?)`, `isAllowedSwisstopoUrl(url)`, `SWISSTOPO_HOSTS`

The host allowlist the CLI and the viewer fetch through. `swisstopoOnlyFetch`
wraps a `fetch` so that any URL off `SWISSTOPO_HOSTS` (https, default port)
throws `SiteContextHostRefused` before it is sent, redirects are refused
(`redirect: 'error'`), and no credentials or referrer go out. Its result fits
both `@ifc-lite/geodata-ch`'s and `@ifc-lite/tiles3d`'s `fetch` option.

### The document

```text
interface SiteContextDocument {
  crs: 'EPSG:2056';
  verticalCrs: 'EPSG:5728';
  origin: [E0, N0, H0];          // whole metres
  originHeight?: { terrainHeight: number | null; reason?: string }; // what H0 is
  layers: {
    kind: 'terrain' | 'parcel' | 'buildings';
    features: {
      id: string;                // 'terrain:chunk:r0c1', 'terrain:skirt', 'parcel:CH…', 'building:egid:…' | 'building:egid:…:uuid:…' (EGID shared by several objects) | 'building:uuid:…'
      ifcType: string;           // 'IfcGeographicElement' | 'IfcSite' | 'IfcBuilding'
      name: string;
      origin: [E, N, H];         // f64, EPSG:2056 / EPSG:5728
      mesh: {
        positions: Float32Array; normals: Float32Array; uvs?: Float32Array; indices: Uint32Array;
        parts?: { name: string; firstIndex: number; indexCount: number }[];  // buildings: 'roof', then 'wall'
      } | null;
      attributes: JSON;
      provenance: JSON;
      subject?: true;            // only on the model's own building
    }[];
    attribution: Attribution[];
    issues: { code: string; severity: 'info' | 'warning' | 'error'; message: string; count?: number }[];
    complete: boolean;
    provenance?: JSON;           // buildings: source, releases, conversion, requests, bytes, caps, subject match
  }[];
}
```

**Frame.** Local axes are identity to the CRS: x east, y north, z up, metres,
scale 1. A vertex's EPSG:2056 / LN02 coordinate is `feature.origin + position`,
added in f64. The document origin is the centre rounded to whole metres.
H0 is the terrain height nearest the centre, rounded, when terrain was read
(`originHeight.terrainHeight`); without terrain `originHeight.terrainHeight`
is `null` with a `reason`, and H0 is 0, a frame offset rather than a height.
Each feature has its own
f64 origin and float32 positions relative to it, which matches the viewer's
precision model (a per-mesh f64 origin plus relative-to-eye rendering). The
document defines the frame; the building model's map conversion does not. A
viewer places the context against the model through the model's own
georeferencing (federation spatial reference). Nothing here applies a model's
rotation or scale.

**Terrain.** The grid comes from `geodata.elevationGrid(bbox, { resolution })`
over the site square, widened outwards to whole multiples of the resolution.
The mesh is split into chunks of up to 128 × 128 cells, each its own feature
with its origin at its south-west node and H0. Normals come from central
differences over the whole grid, so shared edge vertices match exactly. UVs
span the whole terrain box (u east, v south; glTF's top-left origin), ready
for imagery draped later. A cell with a `NaN` corner is dropped and counted
(`terrain-nodata-cells`); nothing is filled in. The `terrain:skirt` feature
walls the outer edge down to the lowest height minus 5 m and adds a bottom,
so the terrain reads as a body. The building footprint is not cut out.
Attributes: `PredefinedType: 'TERRAIN'`, `part`, the resolution. Provenance:
the source tiles with URL, acquisition date, year and GSD, missing tiles, and
the vertical reference.

**Parcel.** Looked up with `parcelById` or `parcelsAtPoint`; every parcel
there is included (overlapping rights). The boundary is densified to about
1 m and built as a ribbon 0.3 m wide, each edge vertex 0.1 m above the
bilinear terrain under it. A vertex over missing terrain or outside the site
gets no height: the ribbon breaks there (`parcel-undraped-vertices`) and the
layer is incomplete. Attributes are laid out for a writer to emit
`Pset_LandRegistration`:

```json
{
  "Pset_LandRegistration": { "LandID": "<EGRID>", "LandTitleID": "<parcel number>" },
  "egrid": "…", "number": "…", "canton": "BE", "cadastralDistrict": "…", "realEstateType": "…",
  "area": 1234.5, "areaKind": "planar area of the returned geometry, computed; not the registered legal area",
  "sourceLayer": "ch.kantone.cadastralwebmap-farbe", "geoportalUrl": "…",
  "oerebExtractUrl": "https://…/extract/url/?EGRID=…", "oerebExtractPdfUrl": "…", "oerebSource": "federal-register"
}
```

A failed ÖREB lookup is an `oereb-lookup-failed` issue on the layer (which is
then incomplete), not a failed build.

**Buildings.** Read through the injected reader (default: the swisstopo
preset of `@ifc-lite/tiles3d`) for the WGS84 box that holds the site
square. Each building becomes one feature (`IfcBuilding`, named from its
object type and EGID), with its own whole-metre origin at its footprint
centre and lowest point, and float32 positions east-north-up.

- *Conversion chain, per vertex:* ECEF (as the reader returns it, f64) →
  geodetic longitude, latitude, height (`ecefToGeodetic`) → easting and
  northing with `@ifc-lite/geo` (`fromWgs84` of EPSG:2056; its datum shift
  is the exactly defined CHTRS95 → CH1903+ translation, no grid) → height
  taken **as stored, as LN02**. That last step rests on an observed property
  of the dataset, not on 3D Tiles: the tiles store Swiss national heights in
  the slot meant for ellipsoidal height (release 20260520: every building
  top equals its `DACH_MAX` to 0.01 m, tile centres sit at ellipsoidal
  height 0; a true ellipsoidal height would be about 50 m higher). No geoid
  correction is applied. A guard compares every top with `DACH_MAX`: more
  than 0.05 m apart is a `buildings-height-check` warning, more than 1 m an
  error that marks the layer incomplete, since it means the dataset changed.
  `@ifc-lite/geo` applies the datum shift at height 0 whatever height it is
  given; at Swiss heights a full 3D shift would move points by about 2 cm,
  below the dataset's accuracy. In the tests, the recorded Bern buildings
  land within 1 cm of an independent implementation of swisstopo's rigorous
  formulas applied to their batch-table longitude and latitude.
- *Mesh:* the tiles store every face twice (identical copies) and the faces
  where a wall solid meets its roof solid once in each material with
  opposite winding. Copies are kept once and those interface faces left out
  (`buildings-repeated-faces`, `buildings-interior-faces`, counted). Winding
  is made consistent across every edge two triangles share (1 mm weld), and
  each connected piece is turned so its area-weighted normals point away
  from the building centre (for a closed piece, positive volume). Normals
  are recomputed flat from the final winding. The result renders
  single-sided and casts shadows. Roofs are closed slabs about 0.2 m thick
  in the data, so a slab underside correctly faces down; every roof triangle
  open to the sky faces up.
- *Parts:* triangles in the red material (roof) come first, then the beige
  (walls, including the base and some non-vertical area), named in
  `mesh.parts`. A group without a colour goes to `wall` and is counted.
- *Attributes* in `IfcLite_SiteContextBuilding` (`BUILDING_SET`): `EGID`,
  `UUID`, `ObjectType`, `TotalHeight` (`GESAMTHOEHE`), `RoofMin`,
  `RoofMax`, `TerrainPoint` (`GELAENDEPUNKT`), `DatasetRelease`,
  `SourceTile`. A column the tile lacks is `null`: Bern, Zürich and Uri tiles
  carry EGID and heights, Geneva and Ticino tiles do not. The layer counts
  them (`buildings-missing-egid`, `buildings-missing-heights`). Provenance
  per feature: release, tile, feature id, tileset chain, measured top and
  the height check.
- *Clipping:* a building is kept, whole, when its footprint (the convex hull
  of its vertices in the lowest quarter of its height) touches the site
  square. `maxFeatures` and `maxTriangles` cap the layer nearest the centre
  first, the subject always kept; a cap is a `buildings-truncated` issue and
  makes the layer incomplete.
- *Subject:* see the `subject` option; the match (`egid`, or `footprint`
  with the overlap and threshold) is in the feature's and the layer's
  provenance, and `buildings-subject-matched` / `buildings-subject-not-found`
  say what happened. The subject is never removed.
- *Reader issues* are grouped by kind (`tiles-http-404`,
  `tiles-missing-attributes`, …) with a count and example URLs; a truncated
  read is `buildings-read-truncated`. Either makes the layer incomplete
  when the reader says the read was not complete.

**Honesty rules.** A layer that could not be completed has `complete: false`
and says why in `issues`. Nothing is substituted: no fallback heights, no
guessed parcel. Attribution travels with each layer. A site where the
provider has no terrain at all is refused with `SiteContextCoverageError`.

## GLB format (version 1)

Version 1 gained three optional fields with the buildings layer. Files
written before them decode exactly as before, and a reader that ignores them
still gets every triangle, so the version did not change.

One glTF 2.0 binary that also opens as plain geometry in any glTF viewer.

- **Scene.** A root node `site-context`, one child node per layer (named by
  kind), and under it **one node per feature**, named by the feature name.
  A feature with a mesh has one mesh with one triangle primitive: `POSITION`
  (float32, with min/max), `NORMAL`, optional `TEXCOORD_0`, `uint32`
  indices, and a plain per-layer material (the parcel is double-sided).
- **Axes.** glTF is Y-up. The site frame maps as
  `(x, y, z)_glTF = (east, up, −north)`, the same Z-up → Y-up turn the viewer
  applies to IFC. Negation is exact.
- **Node translation** = feature origin − document origin, in glTF axes. No
  precision is lost: the two f64 origins are within a factor of two of each
  other, so their difference is exact (Sterbenz), and `JSON.stringify` writes
  each double in its shortest round-trip form, which parses back to the same
  double. The absolute feature origin is also stored in the node's extras.
- **`asset.extras.ifcLiteSiteContext`**: `formatVersion` (1), `crs`,
  `verticalCrs`, `origin`, `originHeight` (optional), `axes`, and per layer `kind`, `attribution`,
  `issues`, `complete`, `node` (the index of its group node) and, when the
  layer has one, `provenance`.
- **Feature node `extras.ifcLiteSiteContext`**: `id`, `ifcType`, `name`,
  `origin`, `attributes`, `provenance`, and `subject: true` on the subject
  building's objects only.
- **Mesh `extras.ifcLiteSiteContext.parts`** (buildings): the named index
  ranges of the mesh's single primitive, `[{ name: 'roof', firstIndex,
  indexCount }, { name: 'wall', … }]`, contiguous and covering every index.
  To style roofs and walls differently, draw each range with its own
  material; a plain glTF viewer draws the whole building in the layer's
  grey. The buildings material is single-sided.

`decodeSiteContextGlb(encodeSiteContextGlb(doc))` reproduces `doc` exactly,
mesh arrays and parts included. A file without the extras, of another
format version, or with parts that do not tile the index buffer, is refused
with `SiteContextFormatError`.

## Tests

`pnpm test` runs against a synthetic geodata client with analytic terrain (a
plane and a paraboloid): heights at nodes, chunk seams, skirt closure, missing
data, counts against the resolution rule, parcel draping, the frame (a known
EPSG:2056 point recovered to sub-millimetre) and the GLB round trip. The
buildings tests read two recorded swisstopo leaf tiles (Bern with EGID and
heights, Geneva without; recorded in `@ifc-lite/tiles3d`'s fixtures) through
its public reader with a stub fetch, and exact synthetic prisms (a box and an
L) through a stub reader: frame, heights, the roof/wall split, winding and
normals, subject matching, clipping, caps and the GLB round trip. No
network. `pnpm smoke:live [radius]` (after building this package and
`@ifc-lite/geodata-ch`) builds a site against the live services and reports
requests, bytes and timing. `node scripts/live-smoke-buildings.mjs [radius]`
(after building this package, `@ifc-lite/geo`, `@ifc-lite/geodata-ch` and
`@ifc-lite/tiles3d`) reads the buildings around the Bundesplatz in Bern
(300 m), marks the Parliament Building as the subject by its register EGID,
cross-checks its position against the building register, and keeps the
tiles on disk so a re-run sends no tile requests. Both are opt-in and never
run in CI.
