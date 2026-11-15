# @ifc-lite/site-context

The site around a georeferenced Swiss building, as data: real terrain
(**swissALTI3D**) and the cadastral **parcel**, in one local frame stated in
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

The FSDI fair-use terms apply to every geo.admin.ch request.

## API

### `buildSiteContext(options): Promise<SiteContextDocument>`

| Option | Meaning |
|---|---|
| `centre` | `{ x, y }` in EPSG:2056. Outside the Swiss coverage → `SiteContextCoverageError`, before any request. |
| `radius` | Half the side of the square site, in metres (0 < r ≤ 5000). |
| `layers` | `'terrain' \| 'parcel' \| 'buildings'`. `buildings` is accepted and returned as an empty, incomplete layer with a `layer-unsupported` issue: it is not built yet. |
| `resolution` | Terrain node spacing in metres, or `'auto'` (default): `max(0.5, extent / 500)` rounded up to 1/16 m, where `extent = 2 · radius`. That keeps the terrain near 501 × 501 nodes (≈ 250 000 vertices, 500 000 triangles): 200 m → 0.5 m, 500 m → 1 m, 1 km → 2 m. The rounding makes every node coordinate exact in float32, so chunk seams are bit-identical. Grids over 4 000 000 nodes are refused. |
| `subject` | `{ footprint?, egid?, egrid? }`: `egrid` takes the parcel by EGRID; otherwise the parcel is the one at the footprint's centroid, or at the centre. `egid` is kept for the buildings layer. |
| `geodata` | A `SwissGeodata` from `@ifc-lite/geodata-ch` (or anything with its `elevationGrid`, `parcelById`, `parcelsAtPoint`, `oerebExtract`). |
| `signal`, `onProgress`, `onLayer` | Abort; progress messages; each finished layer in document order. |

It also exports `summarizeSiteContext(doc)` (per-layer feature, triangle and
vertex counts, parcels with their ÖREB link) and the error classes
`SiteContextCoverageError` and `SiteContextFormatError`.

### The document

```text
interface SiteContextDocument {
  crs: 'EPSG:2056';
  verticalCrs: 'EPSG:5728';
  origin: [E0, N0, H0];          // whole metres
  layers: {
    kind: 'terrain' | 'parcel' | 'buildings';
    features: {
      id: string;                // 'terrain:chunk:r0c1', 'terrain:skirt', 'parcel:CH…'
      ifcType: string;           // 'IfcGeographicElement' | 'IfcSite'
      name: string;
      origin: [E, N, H];         // f64, EPSG:2056 / EPSG:5728
      mesh: { positions: Float32Array; normals: Float32Array; uvs?: Float32Array; indices: Uint32Array } | null;
      attributes: JSON;
      provenance: JSON;
    }[];
    attribution: Attribution[];
    issues: { code: string; severity: 'info' | 'warning' | 'error'; message: string; count?: number }[];
    complete: boolean;
  }[];
}
```

**Frame.** Local axes are identity to the CRS: x east, y north, z up, metres,
scale 1. A vertex's EPSG:2056 / LN02 coordinate is `feature.origin + position`,
added in f64. The document origin is the centre rounded to whole metres, with
H0 the terrain height nearest the centre, rounded. Each feature has its own
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

**Honesty rules.** A layer that could not be completed has `complete: false`
and says why in `issues`. Nothing is substituted: no fallback heights, no
guessed parcel. Attribution travels with each layer. A site where the
provider has no terrain at all is refused with `SiteContextCoverageError`.

## GLB format (version 1)

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
  `verticalCrs`, `origin`, `axes`, and per layer `kind`, `attribution`,
  `issues`, `complete` and `node` (the index of its group node).
- **Feature node `extras.ifcLiteSiteContext`**: `id`, `ifcType`, `name`,
  `origin`, `attributes`, `provenance`.

`decodeSiteContextGlb(encodeSiteContextGlb(doc))` reproduces `doc` exactly,
mesh arrays included. A file without the extras, or of another format
version, is refused with `SiteContextFormatError`.

## Tests

`pnpm test` runs against a synthetic geodata client with analytic terrain (a
plane and a paraboloid): heights at nodes, chunk seams, skirt closure, missing
data, counts against the resolution rule, parcel draping, the frame (a known
EPSG:2056 point recovered to sub-millimetre) and the GLB round trip. No
network. `pnpm smoke:live [radius]` (after building this package and
`@ifc-lite/geodata-ch`) builds a site against the live services and reports
requests, bytes and timing. It is opt-in and never runs in CI.
