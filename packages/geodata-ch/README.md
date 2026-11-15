# @ifc-lite/geodata-ch

Typed, headless client for Swiss federal geodata, the data layer under
site context for IFC models. Every result is data in **LV95 (EPSG:2056)**,
the CRS Swiss models are georeferenced in. It also carries the attribution
the data owner requires. Browser and Node, no rendering, no IFC writing.

- Address and place search, and parcels by EGRID or by point (cantonal
  cadastral web map, via api3.geo.admin.ch).
- Terrain: a regular **swissALTI3D** elevation grid for a box at any
  spacing, read from the Cloud Optimized GeoTIFF tiles by HTTP range
  request. It handles the tile mosaic and picks internal overviews. There are
  no per-point height calls.
- Buildings: **swissBUILDINGS3D 3.0** tile discovery (asset URL, format,
  size, extent). Parsing CityGML is not part of this package.
- Vector context: features of an api3 layer (swissTLM3D roads, railways,
  water network, building register, ...) in a box, polygon or multipolygon.
  Recursive cell splitting gets past the service's 200-feature cap, and
  results are deduplicated.
- ÖREB: where a parcel's public-law-restriction extract lives (JSON, XML,
  PDF and URL forms).
- Descriptors for imagery, basemap and hazard layers (WMTS/WMS), with no
  fetching.

```ts
import { createSwissGeodata, VECTOR_LAYERS } from '@ifc-lite/geodata-ch';

const geo = createSwissGeodata(); // optional: { fetch, cache, requestsPerSecond, ... }

const { candidates } = await geo.geocode('Bundesplatz 3, Bern');
const [parcel] = await geo.parcelsAtPoint(candidates[0].x, candidates[0].y);
const box = { minX: 2_600_300, minY: 1_199_400, maxX: 2_600_700, maxY: 1_199_800 };
const terrain = await geo.elevationGrid(box, { resolution: 2 });
const roads = await geo.features(VECTOR_LAYERS.roads, box);
const oereb = parcel ? await geo.oerebExtract(parcel.egrid) : null;
// Show terrain.attribution, roads.attribution, ... next to the data.
```

## Contracts

`Geocoder`, `ParcelProvider`, `TerrainProvider`, `BuildingTileProvider` and
`VectorFeatureProvider` (in `contracts.ts`) contain nothing Swiss. Every
coordinate carries its CRS string and every result carries `Attribution[]`.
A provider for another country (3DBAG, Overture buildings, Mapterhorn
terrain) implements the same interfaces. Only Switzerland is implemented here.

## Behaviour worth knowing

- **Nothing is filled in silently.** Terrain cells without data are `NaN`,
  counted in `noDataCount`, and the tiles the catalogue lacks are listed in
  `missingTiles`. A box wholly outside coverage is not an error: it is an
  all-`NaN` grid with `hasData === false` and every absent tile in
  `missingTiles`. Vector cells that still hit the cap at the deepest split
  come back in `truncatedCells`. If `maxRequests` runs out, `features`
  returns what was collected with `requestLimitReached` and `unqueriedCells`
  set; `truncated` is `true` for either cause, so check it before treating
  the result as complete. A layer whose terms this package has not recorded
  is attributed as such, never left without attribution.
- **Coordinates are checked.** `x` is the easting and `y` the northing
  everywhere: `parcelsAtPoint(x, y)`, `oerebExtractsAtPoint(x, y)`, the
  `Geocoder` candidates, and bounding boxes (`minX`/`maxX` eastings). Every
  entry point throws a `RangeError` for values outside LV95, and says the
  arguments look swapped when exchanging them would fit. Without that, a
  swapped call returns `[]`, which reads as "no parcel here".
- **A parcel without a usable extract is not "no record".**
  `oerebExtractsAtPoint(x, y)` returns `{ extracts, unavailable }`: a parcel
  the register lists without an extract URL is in `unavailable`, and only both
  lists empty means the register has nothing there. `geocode`'s `limit` must be
  a whole number from 1 to 50, otherwise it throws a `RangeError`.
- **Request counts say what they count.** `FeatureQueryResult.requests` is the
  number of cell queries (what `maxRequests` budgets); `networkRequests` is
  what was sent, retries included and cache hits excluded.
- **Long polygons.** A polygon query travels as JSON in a GET URL, so a parcel
  with hundreds of vertices can exceed URL limits. Above `maxUrlLength`
  (default 6000 characters) a cell is queried by its bounding box instead and
  the features are clipped to the polygon here; those cells are listed in
  `bboxFallbackCells`. A `MultiPolygon` is queried member by member and
  merged.
- **Vertical reference.** swissALTI3D heights are **LN02 (EPSG:5728)**.
  swisstopo's product page gives the coordinate system as "LV95 LN02", and
  every asset name ends in `_2056_5728`. swissBUILDINGS3D assets carry the
  same `_2056_5728` suffix. Results state `verticalCrs: 'EPSG:5728'`.
- **Terrain sampling.** Values sit at grid nodes
  (`x = origin.x + col·resolution`, rows run north to south). They are
  bilinear from the coarsest internal level that is no coarser than the
  requested spacing: 2 m product with its 4 m overview for spacings of 2 m or
  more, otherwise the 0.5 m product (0.5/1/2/4 m). By default each tile uses
  its newest acquisition year; pass `year` to pin one. A node that sits on a
  pixel corner of the source raster averages the four surrounding source
  pixels at native resolution with equal weight, so a finer spacing than the
  source is interpolation, not new detail. `sources[].gsd` is the real
  resolution of the raster level that was read.
- **WGS84 only for query boxes and tile extents.** The STAC API wants a WGS84
  `bbox`, so swisstopo's published *approximate* LV95↔WGS84 formulas build a
  padded box, and the extent of a swissBUILDINGS3D tile
  (`BuildingAsset.extent`, flagged `extentApproximate`) is derived through
  them. Measured against the official reframe service the error is 0.2–0.4 m
  centrally and about 3 m at the periphery (2485000/1110000: 2.82 m;
  2830000/1080000: 3.04 m), not the "about 1 m" the formulas' documentation
  suggests. Query boxes are padded by 60 m by default (50 m plus a 10 m
  error allowance, over three times the worst error). The formulas are
  internal to the package and never applied to returned geometry. This
  package does no reprojection.
- **Parcel area** is `computedArea`, the planar area of the returned
  geometry. The service does not expose the registered legal area.
- **HTTP.** All requests go through one client: injectable `fetch`, a cache
  hook (`{ get, set }` keyed by URL plus `Range`), per-host rate limiting
  (default 5 requests/s) and truncated exponential backoff with jitter on
  408/425/429/500/502/503/504, network errors and timeouts, honouring `Retry-After` in
  both its seconds and HTTP-date forms, capped at `maxDelayMs` (default 32 s):
  a server that asks for a longer wait is retried after the cap, not the full
  wait, so raise `maxDelayMs` if you want to honour it fully. That is the retry strategy
  geo.admin.ch asks clients to use. Each attempt has a timeout (`timeoutMs`,
  default 30 s) combined with the caller's `AbortSignal`: either aborts the
  request. A stalled socket surfaces as a typed `HttpTimeoutError` once the
  retry budget is spent. The `User-Agent` is the generic
  `ifc-lite-geodata-ch`, set only where the runtime allows it without a CORS
  preflight (Node, Deno, Bun), never from a browser or web worker. No
  identifying header is ever sent.

## Services used (checked live 2026-11-15)

| Purpose | Endpoint |
|---|---|
| Search | `https://api3.geo.admin.ch/rest/services/api/SearchServer` (`type=locations`, `sr=2056`) |
| Parcels | `.../all/MapServer/find` and `identify`, layer `ch.kantone.cadastralwebmap-farbe`, field `egris_egrid` |
| ÖREB register | layer `ch.swisstopo-vd.stand-oerebkataster` (`find` by `egris_egrid`, or `identify`) |
| Vector layers | `.../all/MapServer/identify`, tolerance 0, no `mapExtent` (with one, the server applies scale-dependent filtering: 32 vs 95 roads for the same polygon) |
| Terrain | STAC `https://data.geo.admin.ch/api/stac/v1`, collection `ch.swisstopo.swissalti3d` |
| Buildings | STAC collection `ch.swisstopo.swissbuildings3d_3_0` (tiled `citygml.zip`, `dwg.zip`, `gdb.zip`; nationwide `fullcoverage` gdb ignored) |
| Imagery/hazard | `https://wmts.geo.admin.ch` (EPSG:2056 capabilities) and `https://wms.geo.admin.ch/` |

Findings from that check:

- The federal layer `ch.swisstopo-vd.geometa-grundstueck` is gone ("No GeoTable was found").
- `identify` paging with `offset` returned overlapping pages, so the client splits cells instead of paging.
- SearchServer drops `x`/`y` when `returnGeometry=false`. With `sr=2056` it also puts the northing in `x` and the easting in `y`; the client assigns them by value range.
- The overland-flow hazard map (`ch.bafu.gefaehrdungskarte-oberflaechenabfluss`) is raster only: WMTS and WMS, no `identify`.

## ÖREB service table

The parcel's extract URL comes from the federal availability register first.
`CANTON_OEREB_SERVICES` is the fallback when the register has no record for
the parcel. To build it, the register was queried in each capital, the base
was taken from its `oereb_extract_url`, and `GET {base}/versions/{json|xml}`
had to answer 200 (SO and SH: only `/versions/xml` did, `/versions/json`
answered 500; their entries say so). The register's `oereb_webservice` field was wrong for GL,
ZG, SH and JU, so it is not used. 25 cantons are **verified** on 2026-11-15.
**VS** (`https://rdppf.apps.vs.ch`) is **unverified**: the register lists it,
but it timed out from the checking host. Every entry carries its own
verification state and date.

## Licence and attribution

Read on 2026-11-15. `attributionFor(id)` / `DATASETS` expose the same data at
runtime, and each result carries its entries in `attribution`.

| Dataset | Show | Terms | Source |
|---|---|---|---|
| swissALTI3D, swissBUILDINGS3D 3.0, swissTLM3D, national map, hillshade, search | `© swisstopo` | swisstopo OGD: use, distribute, process and use commercially; a source reference is mandatory | [swisstopo OGD terms](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices); swissALTI3D geocat "Opendata BY"; swissTLM3D geocat "Freie Nutzung. Quellenangabe ist Pflicht." |
| SWISSIMAGE | `© CNES, Spot Image, swisstopo, NPOC`: the **layer-level** text from the api3 layer configuration. The product page gives the source line per vintage and is authoritative: <https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10> | swisstopo OGD as above | same |
| Building register (GWR, `ch.bfs.gebaeude_wohnungs_register`) | `© FSO, ...` | Opendata BY: open use, must provide the source. Only access-level A attributes are public (Art. 16 VGWR) | geocat 56553efe-4a2c-449d-93ba-cf7edd518d56 |
| Overland-flow hazard map (FOEN) | `© FOEN` | Opendata OPEN: open use | geocat 6b59f9ee-9e5f-4b12-86cf-f8afb539ae5d |
| ÖREB availability register | `© swisstopo` | "Keine Einschränkung" | geocat fb60594e-2b16-45af-9bc0-b444035070f5 |
| Cadastral web map (parcels) | `© Cadastral surveying (CS) and the cantons` | **Not verified.** Geocat points to `http://www.cadastre.ch/cwm`, which returned 404. The cantons own the data; check the canton's terms before redistributing parcel geometry | geocat cf93dfb6-ffff-43ce-bd9b-271baba2d217 |

The swisstopo terms also name datasets that need a different source line than
`© swisstopo`; the exact wording is in each dataset's documentation, so check
it for any dataset not in the table above.

The FSDI general terms apply to every geo.admin.ch service:
<https://www.geo.admin.ch/en/general-terms-of-use-fsdi>. Use is free of
charge under fair use, and access can be restricted on excessive use.
Automated high-intensity parsing should be avoided. Whole datasets for
offline systems should come from the download service. The page refers to
a requests-per-time-unit table, but no table appears on the page, so the
5 requests/s default is ifc-site's working figure, not a published limit.
swissBUILDINGS3D 3.0 is labelled "Beta" in the STAC catalogue. ÖREB
extracts are issued by each canton; this package only builds their URLs.

## Tests

`pnpm test` runs against trimmed recorded responses in `test/fixtures`, plus
tiny tiled GeoTIFFs with internal overviews built in the test. There is no
network access. `pnpm smoke:live` (after `pnpm build`) exercises the real
services. It is opt-in and never runs in CI.
