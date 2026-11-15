# Site Context (Switzerland)

Real terrain and the cadastral parcel around a georeferenced Swiss building
model, as one GLB in a frame stated in **EPSG:2056 (LV95)** with **LN02
(EPSG:5728)** heights, plus a JSON summary. The data comes from the federal
geodata services through `@ifc-lite/geodata-ch`: **swissALTI3D** terrain
read straight from the cloud-optimised tiles, and the cantonal cadastral web
map for the parcel, with its ÖREB extract link.

This is the headless core. Showing the context in the viewer, neighbouring
buildings, and writing it into IFC come later and build on the same document
and GLB format.

## Attribution is required

Every layer carries the attribution its data owners require, in the JSON
summary and inside the GLB. Show it wherever the context is shown:

- Terrain: **© swisstopo** (swisstopo open data: free use including
  commercial, source reference mandatory).
- Parcel: **© Cadastral surveying (CS) and the cantons**. These terms are
  **not verified**: the cantons own the data, and the terms page the
  catalogue points to is gone. Check the canton's terms before
  redistributing parcel geometry. The parcel layer always carries a
  `terms-unverified` issue saying so.

## From the CLI

```bash
ifc-lite site-context model.ifc --radius 300 --layers terrain,parcel --resolution auto --out context.glb --json
```

The centre is the model's `IfcMapConversion` origin (Eastings/Northings,
converted from the map unit to metres). The command needs a map conversion
whose CRS is EPSG:2056. The literal `EPSG:2056` is accepted, and so are names
`@ifc-lite/geo` resolves to it, such as `CH1903+ / LV95`. The summary says
which form matched. A model in another CRS `@ifc-lite/geo` can transform,
such as LV03 (EPSG:21781), has **only its centre point** reprojected, and the
summary says so. A model without a map conversion is refused with a pointer
to `ifc-lite georef set`. A stated vertical datum other than LN02 is refused
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
| `--layers L,...` | `terrain,parcel` | `buildings` is accepted and reported as not implemented yet |
| `--resolution R\|auto` | `auto` | Terrain node spacing: `max(0.5, 2·radius/500)` m, rounded up to 1/16 m |
| `--out F` | required | The GLB to write |
| `--json` | | Print the summary as JSON |
| `--cache-dir D` | `$XDG_CACHE_HOME/ifc-lite/geodata` | Response cache on disk, keyed by URL and Range |
| `--offline` | | Answer only from the cache; nothing is sent |
| `--rate R` | 5 | Requests per second per host |

Network access is on by default, at the geodata client's rate limit, and
every response is cached, so a second run of the same site sends nothing.

A run of `--centre 2600423,1199521 --radius 100` against the live services
(Bundesplatz, Bern) sent 19 requests, downloaded 1.3 MB and took about 4 s.
It wrote a 9.4 MB GLB: 17 terrain features (16 chunks and the skirt) with
323 202 triangles at 0.5 m, plus the parcel with its ÖREB link. The parcel
there reaches beyond the 200 m site, so its ribbon breaks where the terrain
ends and the layer reports `parcel-undraped-vertices`. These are numbers from
one run, not a benchmark.

The JSON summary has the document origin and CRS, per layer the feature,
triangle and vertex counts, completeness, attribution and issues, plus the
GLB size, the requests made, the cache use, the parcel's EGRID, number and
ÖREB link, and, from a model, which CRS form matched, the map unit and the
model's rotation (with `rotationApplied: false`).

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
  whole metres, with H0 the terrain height there. Every feature has its own
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
- **Honesty.** A layer that could not be completed says `complete: false`
  and lists its issues. A centre outside Switzerland is refused.

The full format, including how node translations keep full precision, is in
the [`@ifc-lite/site-context` README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/site-context#glb-format-version-1).
