# Site Context (Switzerland)

Real terrain, the cadastral parcel and the neighbouring buildings around a
georeferenced Swiss building model, as one GLB in a frame stated in
**EPSG:2056 (LV95)** with **LN02 (EPSG:5728)** heights, plus a JSON summary.
The data comes from the federal geodata services: **swissALTI3D** terrain
read straight from the cloud-optimised tiles and the cantonal cadastral web
map for the parcel, with its ÖREB extract link, through
`@ifc-lite/geodata-ch`; and **swissBUILDINGS3D** buildings from swisstopo's
3D Tiles through `@ifc-lite/tiles3d`.

This is the headless core. Showing the context in the viewer and writing it
into IFC build on the same document and GLB format.

## Attribution is required

Every layer carries the attribution its data owners require, in the JSON
summary and inside the GLB. Show it wherever the context is shown:

- Terrain: **© swisstopo** (swisstopo open data: free use including
  commercial, source reference mandatory).
- Buildings: **© swisstopo (swissBUILDINGS3D)** (swisstopo open data, as
  terrain).
- Parcel: **© Cadastral surveying (CS) and the cantons**. These terms are
  **not verified**: the cantons own the data, and the terms page the
  catalogue points to is gone. Check the canton's terms before
  redistributing parcel geometry. The parcel layer always carries a
  `terms-unverified` issue saying so.

## From the CLI

```bash
ifc-lite site-context model.ifc --radius 300 --layers terrain,parcel,buildings --resolution auto --out context.glb --json
```

The centre is the model's `IfcMapConversion` origin (Eastings/Northings,
converted from the map unit to metres). The command needs a map conversion
whose CRS is EPSG:2056. The literal `EPSG:2056` is accepted, and so are names
`@ifc-lite/geo` resolves to it, such as `CH1903+ / LV95`. The summary says
which form matched. A model in another CRS `@ifc-lite/geo` can transform,
such as LV03 (EPSG:21781), has **only its centre point** reprojected, and the
summary says so. A model without a map conversion is refused with a pointer
to adding one (or to `--centre E,N`). A stated vertical datum other than LN02 is refused
rather than mixing height systems; a model that states none proceeds with a
warning.

The model's rotation and scale are never applied: the context is placed
against the model by the model's own georeferencing, the same way federated
models are placed.

Without a model:

```bash
ifc-lite site-context --centre 2600423,1199521 --radius 100 --out context.glb
ifc-lite site-context --egrid CH294676423526 --radius 150 --out context.glb
```

| Option | Default | Meaning |
|---|---|---|
| `--radius M` | 150 | Half the side of the square site, metres (max 5000) |
| `--layers L,...` | `terrain,parcel` | Any of `terrain`, `parcel`, `buildings` |
| `--subject-egid N` | | The model's own building among the neighbours, by EGID |
| `--tile-requests N` | 64 | Request budget of the buildings tile read; cache hits are free |
| `--resolution R\|auto` | `auto` | Terrain node spacing: `max(0.5, 2·radius/500)` m, rounded up to 1/16 m |
| `--out F` | required | The GLB to write |
| `--json` | | Print the summary as JSON |
| `--cache-dir D` | `$XDG_CACHE_HOME/ifc-lite/geodata` | Response cache on disk, keyed by URL and Range; building tiles go in its `tiles3d` folder |
| `--offline` | | Answer only from the cache; nothing is sent |
| `--rate R` | 5 | Requests per second per host |

Network access is on by default, at the geodata client's rate limit, and
every response is cached, so a second run of the same site sends nothing.
Every request goes through a swisstopo host allowlist (`api3`, `data`, `wms`,
`wmts` and `3d.geo.admin.ch`, https only): no option names a URL, a URL taken
from a response (a STAC page link, a tileset's content URI) on any other host
is refused before it is sent, and redirects are not followed.

The map conversion's unit comes from `IfcProjectedCRS.MapUnit`, else the
project length unit. When the map unit reads as metres the summary warns that
metres are assumed: the reader also reports an unreadable `MapUnit` as
metres, so a declared metre and an unreadable unit look the same.

A run of `--centre 2600423,1199521 --radius 100` against the live services
(Bundesplatz, Bern) sent 19 requests, downloaded 1.3 MB and took about 4 s.
It wrote a 9.4 MB GLB: 17 terrain features (16 chunks and the skirt) with
323 202 triangles at 0.5 m, plus the parcel with its ÖREB link. The parcel
there reaches beyond the 200 m site, so its ribbon breaks where the terrain
ends and the layer reports `parcel-undraped-vertices`. These are numbers from
one run, not a benchmark.

With `--layers buildings`, a run of `--centre 2600423,1199521 --radius 300`
(Bundesplatz, Bern, live tileset release 20260520) found 420 buildings, 390
with an EGID, in 57 tile requests and 19.3 MB, most of it the 5–12 MB index
JSON files the cache then keeps; the building meshes came to 169 966
triangles and a 15 MB GLB, and a re-run from the cache took about 3 s. With
`--subject-egid 2242547` the Parliament Building was marked as the subject.
One run, not a benchmark. For a 1 km urban site, raise `--tile-requests`:
when the budget stops the read, the layer is marked incomplete and says how
many tiles were left.

The JSON summary has the document origin and CRS, per layer the feature,
triangle and vertex counts, completeness, attribution and issues, plus the
GLB size, the requests made, the cache use, the parcel's EGRID, number and
ÖREB link, and, from a model, which CRS form matched, the map unit and the
model's rotation (with `rotationApplied: false`). With buildings it adds
`buildings`: the count, how many have an EGID, the subject and how it was
matched, the tile requests, bytes and cache hits, the triangles per part,
the model footprint used for matching, and the layer's issues.

## From TypeScript

```ts
import { createSwissGeodata } from '@ifc-lite/geodata-ch';
import { buildSiteContext, encodeSiteContextGlb, summarizeSiteContext } from '@ifc-lite/site-context';

const doc = await buildSiteContext({
  centre: { x: 2_600_423, y: 1_199_521 },
  radius: 100,
  layers: ['terrain', 'parcel'],
  geodata: createSwissGeodata(),
});
const glb = encodeSiteContextGlb(doc);
for (const layer of summarizeSiteContext(doc).layers) {
  console.log(layer.kind, layer.triangles, layer.complete, layer.attribution.map((a) => a.text));
}
```

## What is in the file

- **One frame.** The document origin `[E0, N0, H0]` is the centre rounded to
  whole metres. H0 is the terrain height
  nearest the centre, rounded, when terrain was read; `originHeight` then
  carries it as `terrainHeight`. Without terrain (only buildings, or the
  elevation grid failed) `originHeight.terrainHeight` is `null` with the
  reason, and H0 is 0: a frame offset, not a height. Every feature has its own
  f64 origin and float32 positions relative to it. Local axes are east,
  north and up; in the GLB they are turned to glTF's Y-up as
  `(east, up, −north)`.
- **Terrain** in chunks of up to 128 × 128 grid cells, each its own feature
  (`IfcGeographicElement`, `PredefinedType` TERRAIN), plus a skirt down to
  5 m below the lowest point so the terrain reads as a body. Cells without
  data are left out and counted; no height is ever made up. UVs span the
  terrain so imagery can be draped later. The source tiles and their year
  are in the provenance.
- **Parcel** as a 0.3 m ribbon 0.1 m above the terrain (`IfcSite`), with
  attributes laid out for `Pset_LandRegistration` (`LandID` = EGRID,
  `LandTitleID` = parcel number), the computed area, canton, source layer and
  the ÖREB extract link. A failed ÖREB lookup is an issue on the layer, not a
  failed run.
- **Buildings**, one `IfcBuilding` feature per swissBUILDINGS3D building
  object whose footprint touches the site square, kept whole (never cut at the
  boundary). Each mesh has a `roof` and a `wall` part (the tiles' red and
  beige materials), outward winding and flat normals, so it renders
  single-sided and casts shadows. Attributes are in the
  `IfcLite_SiteContextBuilding` set: `EGID` (where the canton's tiles have
  it, else `null`), `UUID`, `ObjectType`, `TotalHeight`, `RoofMin`,
  `RoofMax`, `TerrainPoint`, `DatasetRelease`, `SourceTile`. Ids are
  `building:egid:<EGID>`; where the tiles split one building into several
  objects sharing an EGID, each gets `building:egid:<EGID>:uuid:<UUID>`, so
  every id is unique. The model's own building is marked `subject: true`
  (every object of it, when it is split), even past the building and
  triangle caps, matched by `--subject-egid`, else by
  overlap of at least half the smaller footprint with the plan rectangle
  spanned by the model's element placements (LOD0 boxes: an element's
  `IfcBoundingBox` where it has one, else its placement point), carried
  through the map conversion, rotation included. That rectangle is coarse; a
  wall placed at one end can leave it short of the outline. When the
  buildings layer is built from a model, the parcel is looked up at that
  rectangle's centre instead of the map conversion origin. The subject is
  kept: a viewer decides to hide it. Buildings without EGID or heights, and
  anything capped, are counted in the issues.
- **Honesty.** A layer that could not be completed says `complete: false`
  and lists its issues. A centre outside Switzerland is refused.

The full format, including how node translations keep full precision, is in
the [`@ifc-lite/site-context` README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/site-context#glb-format-version-1).
