# @ifc-lite/geo

Headless CRS engine for IFC-Lite. Resolve a coordinate reference system from
an EPSG code, a name or a WKT, convert points to and from WGS84, read the grid
convergence and point scale factor at a point, and look up the EGM96 geoid
undulation.

It runs in Node and in the browser, and it makes no network request unless
you install a loader. This is the engine the IFC-Lite viewer places models on
a map with; it was extracted so the CLI, the MCP server and the SDK can use
the same code.

## Installation

```bash
npm install @ifc-lite/geo
```

## Usage

```ts
import { resolveCrs } from '@ifc-lite/geo';

// Any one of epsg, name or wkt identifies the CRS.
const lv95 = await resolveCrs({ epsg: 2056 });      // or { name: 'LV95' }
if (!lv95) throw new Error('unknown CRS');

// CRS -> WGS84. East comes first: [easting, northing] in, [longitude, latitude] out.
lv95.toWgs84([2600000, 1200000]);                   // [7.4386..., 46.9510...]

// WGS84 -> CRS.
lv95.fromWgs84([7.438632, 46.951083]);              // [2599999.97..., 1200000.03...]

// A third component is carried through unchanged (see "Heights").
lv95.toWgs84([2600000, 1200000, 540]);              // [7.4386..., 46.9510..., 540]

// Grid convergence (radians) and point scale factor at a point.
const factors = lv95.gridFactors(2600000, 1200000); // { gamma, pointScale }
```

## API

### `resolveCrs(input)`

<!-- docs-check: skip -->
```ts
resolveCrs(input: { epsg?: number | string; name?: string; wkt?: string }): Promise<CrsTransformer | null>
```

Resolves to `null` when the CRS cannot be identified.

| Field | Accepts |
|---|---|
| `epsg` | `2056`, `'2056'` or `'EPSG:2056'` |
| `name` | `'EPSG:2056'`, or an alias authoring tools write: `LV95`, `LV03`, `RD New`, `British National Grid`, `Lambert-93`, `ETRS89 / UTM zone 32N`, and others |
| `wkt` | WKT1 or WKT2, single or compound (the horizontal part is used) |

When more than one field is given, a readable `wkt` defines the CRS, then
`epsg`, then `name`. A WKT that carries an EPSG identifier resolves through the
registry rather than through its own parameters, and keeps a `TOWGS84` and an
extent (`USAGE`/`BBOX`) it states.

Definitions come from, in order: the EPSG index bundled in `@ifc-lite/data`
(7000+ codes, loaded on first use), the name aliases, the WKT, and last the
EPSG definition loader if you installed one.

### `CrsTransformer`

| Member | Meaning |
|---|---|
| `toWgs84([x, y, z?])` | CRS coordinates to WGS84 `[longitude, latitude, z?]`. |
| `fromWgs84([lon, lat, z?])` | WGS84 to CRS coordinates `[x, y, z?]`. |
| `gridFactors(x, y)` | `{ gamma, pointScale }` at a point, or `null`. |
| `kind` | `'projected'` or `'geographic'`. |
| `epsg` | The EPSG code the input resolved through, or `null`. |
| `datumShift` | How the datum shift to WGS84 is done (see "Accuracy"). |
| `definition` | The proj4 definition in use. Treat it as opaque. |

**Units and axis order.** A projected CRS is read and written in **metres**,
whatever unit the CRS is defined in: a US survey foot CRS still takes and
returns metres. A geographic CRS and WGS84 use degrees. East or longitude is
always first.

**Refusals.** `toWgs84` and `fromWgs84` return `null` instead of a wrong
position: for a non-finite input, a latitude or longitude out of range, a point
outside the coverage of a loaded datum grid, and a result outside the extent
the WKT declares.

**Grid factors.** `gamma` is the grid convergence in radians,
counter-clockwise positive: grid north is true north rotated by `+gamma`.
`pointScale` is grid distance over distance on the WGS84 ellipsoid. Both are
measured by central differences through the projection, so they work for any
projection, and they include the datum shift. They agree with PROJ to 5e-11 on
transverse Mercator, Lambert conformal conic and Krovak (the test oracle,
`src/__fixtures__/proj-oracle.json`). `gridFactors` is `null` for a geographic
CRS and within 0.1 degrees of a pole. To reduce a ground distance to the grid
you also need the height: multiply `pointScale` by `R / (R + h)`.

### Network loaders

Two things can need the network, and both are off until you turn them on:

```ts
import { configureCrsLoaders, epsgIoDefinitionLoader, projCdnGridLoader } from '@ifc-lite/geo';

configureCrsLoaders({
  epsgDefinition: epsgIoDefinitionLoader(), // epsg.io, for codes the bundled index lacks
  gridFile: projCdnGridLoader(),            // cdn.proj.org, datum-shift grids
});
```

Both factories use the global `fetch` and accept your own. A loader is just a
function, so you can read grids from disk or a mirror instead:

```ts
import { readFile } from 'node:fs/promises';
import { configureCrsLoaders } from '@ifc-lite/geo';

configureCrsLoaders({
  gridFile: async (filename) => (await readFile(`/var/proj-data/${filename}`)).buffer as ArrayBuffer,
});
```

`configureCrsLoaders` replaces both loaders and returns the previous ones. A
CRS resolved before a grid loader was installed keeps the definition it got;
resolve it again to pick the grid up.

### `egm96Undulation(latitude, longitude)`

Height of the EGM96 geoid above the WGS84 ellipsoid, in metres:
`ellipsoidal height = orthometric height + undulation`.

### `@ifc-lite/geo/proj4`

The definition-string layer underneath `resolveCrs` (`resolveProjection`,
`resolveProjectionOperation`, `reprojectPointToLatLon`,
`computeGridPointFactors` and others). It exists for a host that calls proj4
itself, as the viewer's globe placement does. A definition returned for a WKT
is a handle registered with the proj4 instance this package imports, so it is
only valid there. Prefer `resolveCrs`.

## Accuracy

The engine is proj4js with the EPSG registry, plus datum-shift grids where the
registry's 7-parameter shift is not good enough. What that means in practice:

- **Datum shifts.** For the CRSs below a 7-parameter (`+towgs84`) shift is
  about a metre or more off, and the engine uses PROJ's published grid when a
  grid loader is installed. Without the grid it falls back to a 7-parameter
  shift and says so in `datumShift`. The last column is the error of that
  shift as recorded next to each entry of the grid table
  (`src/precision-grid-table.ts`); it is a guide, not a measured bound.

  | Region | CRS | Grid | 7-parameter shift is off by |
  |---|---|---|---|
  | Switzerland | LV03 (EPSG:21781) | CHENyx06 | 0.5 to 1 m |
  | Netherlands | RD New (EPSG:28992, 7415) | RDNAPTRANS2018 | up to about 117 m |
  | United Kingdom | British National Grid (EPSG:27700) | OSTN15 | 1 to 20 m |
  | Belgium | Lambert 72 (EPSG:31370) | BD72 to ETRS89 | 2 to 5 m |
  | Germany | DHDN Gauss-Krüger zones 2 to 5 | BeTA2007 | 1 to 3 m |
  | Austria | MGI Lambert and Gauss-Krüger | AT_GIS_GRID | 1 to 3 m |
  | France | NTF Lambert zones | NTF to RGF93 | 1 to 3 m |
  | Spain | ED50 / UTM 29N to 31N | SPED2ETV2 | 1 to 2 m |
  | Portugal | Datum 73 (EPSG:27493) | D73 to ETRS89 | 1 to 3 m |
  | USA | NAD27 / UTM 3N to 19N | NADCON5 | 5 to 50 m |
  | Australia | AGD66, AGD84 / AMG | national grids | 1 to 5 m |
  | Brazil | SAD69 | SAD69_003 | 5 to 10 m |
  | New Zealand | NZGD49 / NZMG (EPSG:27200) | nzgd2kgrid0005 | not recorded |

  `datumShift` is `'as-defined'` when the CRS's own operation is in use,
  `'helmert-approximation'` when a 7-parameter shift stands in for a grid that
  was not available, and `'grid-unavailable'` when the CRS needs a grid and no
  replacement is known, in which case no shift is applied and positions can be
  tens to hundreds of metres off. Check it before you rely on a position.

- **Regional frames are treated as WGS84.** ETRS89, NAD83, GDA94 and similar
  frames are taken to coincide with WGS84. There is no coordinate epoch and no
  plate-motion model, so this is not a sub-decimetre transformation to a
  current WGS84 realisation. LV95 (EPSG:2056) and Lambert-93 need no grid for
  this reason, and carry this caveat.

- **Czech S-JTSK** has no usable single horizontal grid and always uses the
  7-parameter shift, about 1 m.

- **A WKT without a datum shift.** A WKT that declares a non-WGS84 datum
  without `TOWGS84` or a `BOUNDCRS` gets no shift, and a warning is logged.

## Heights

**There is no vertical transformation.** `z` passes through `toWgs84` and
`fromWgs84` unchanged, so a height above the CRS's vertical datum (LN02, NAP,
NAVD88, ...) is still that afterwards. It is not an ellipsoidal height.

`egm96Undulation` interpolates a bundled 1 degree EGM96 grid. It is accurate to
well under a metre and exists to correct a gross placement error: without it a
model drawn at orthometric height sits 40 to 50 m under a globe's terrain in
Central Europe. **It is not a survey-grade vertical transform**, and EGM96 is
not the geoid any national height system is defined on.

## The patched WKT reader

This package pins `wkt-parser` 1.6.0. Inside this repository that version is
patched (`patches/wkt-parser@1.6.0.patch`) to read WKT1-style parameter names
(`central_meridian`, `latitude_of_origin`, `scale_factor`) inside a WKT2
`CONVERSION`. pnpm applies patches only in the workspace that declares them,
so an npm install of this package gets the unpatched reader, which does not
pick those parameters up from a WKT2. WKT2 that uses the EPSG parameter names
(`Longitude of natural origin`, ...) and WKT1 are unaffected.

## License

MPL-2.0
