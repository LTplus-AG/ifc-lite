# @ifc-lite/flood-check

Headless screening of a georeferenced building model against a surface-runoff
hazard map: which doors, windows, openings, light wells, external stairs and
ramps, and which technical equipment in the lowest storeys sit within or below
the mapped water-depth class next to the building.

One provider ships: the Swiss federal **Gefährdungskarte Oberflächenabfluss**
(BAFU, layer `ch.bafu.gefaehrdungskarte-oberflaechenabfluss`). The interfaces
are country-neutral; terrain and anything else comes in through small
interfaces the caller injects.

> **Screening only.** The map is modelled without field verification, ignores
> river flooding, protective structures and culverts, and must not be used at
> scales more detailed than 1:12,500. Areas shown unaffected may still be
> affected. It is not legally binding. Show `BAFU_DISCLAIMER` and
> `BAFU_ATTRIBUTION` with every result. Every result object and every element
> property set also carries a screening caveat (`caveat`), what its outcome
> establishes and what it does not (`meaning`), the attribution and the
> dataset date. The check never reports a favourable outcome the data does not
> support, and refuses outright when the model's height reference is
> implausible.

## Usage

```ts
import { IfcParser } from '@ifc-lite/parser';
import {
  BAFU_ATTRIBUTION,
  BAFU_CLASSES,
  BAFU_DISCLAIMER,
  createBafuRunoffProvider,
  extractModelFacts,
  runFloodCheck,
  toPropertySets,
  type TerrainSource,
} from '@ifc-lite/flood-check';

declare const bytes: ArrayBuffer;
declare const terrain: TerrainSource; // e.g. swissALTI3D, see "Terrain" below

const store = await new IfcParser().parseColumnar(bytes);
const facts = extractModelFacts(store, { expectedCrs: 'EPSG:2056' });
const result = await runFloodCheck(facts, createBafuRunoffProvider(), terrain);
for (const r of result.results) console.log(r.candidate.name, r.outcome, r.meaning.en, r.caveat.en);
const { site, elements } = toPropertySets(result, BAFU_CLASSES);
console.log(site.Name, elements.length, BAFU_ATTRIBUTION, BAFU_DISCLAIMER.de);
```

`checkFloodExposure(facts, raster, terrainSampler, options)` is the pure core:
no I/O. `runFloodCheck` refuses a plan extent no building has, fetches one
raster over the building and the terrain under it, asks the provider to
confirm the layer renders when that raster is wholly transparent, and calls it
with the provider's coverage perimeter.

## Interfaces

- **`HazardProvider`** — `fetchRaster({ bbox, crs, cellSize?, signal? })` returns a
  north-up `ClassifiedHazardRaster`: one class code per cell (`CELL_NO_RUNOFF`,
  `CELL_UNCLASSIFIED`, or `k` for `classes[k-1]`), cell size, top-left origin,
  counts of classified / no-runoff / unclassified cells, and provenance
  (dataset, dataset date, retrieval time, request URL, attribution, licence,
  return-period wording, limits, disclaimer). It declares its `crs`, `extent`
  and `modelCellSize`, and optionally `covers(point)` (its coverage
  perimeter: `true`, `false`, or `null` when too close to tell) and
  `confirmRendering()` (a small request where the map is known to show
  runoff).
- **`TerrainSource`** — `heightAt(point)` and/or `grid(bbox, { resolution })`,
  with its `crs`, its `verticalCrs` as an EPSG identifier (for example
  `EPSG:5728` for LN02), an optional display `verticalReference`, and its
  stated 1-sigma `verticalAccuracy`. Vertical CRSs are compared by EPSG code,
  never by free text. Without `verticalAccuracy` nothing is ever reported
  `above-mapped-class-range`.
- **`TerrainGrid`** — north-up, field-compatible with `ElevationGrid` of
  `@ifc-lite/geodata-ch` (`values`, `resolution`, `origin`, `verticalCrs`,
  `verticalReference`, `hasData`), plus a required `sampling`: `'node'` when
  `values[row * width + col]` is the height AT
  `(origin.x + col * resolution, origin.y - row * resolution)` (origin = the
  north-west node, the geodata-ch convention), `'cell-centre'` when it is the
  height at the centre of the cell whose north-west corner that is (the
  GeoTIFF pixel-is-area convention). NaN is no data; `hasData: false` means no
  heights at all.
- **`ModelFacts`** — plain data from `extractModelFacts`, or built by hand.

### Terrain: the `@ifc-lite/geodata-ch` swissALTI3D client

That client returns node grids in LN02 (`verticalCrs: 'EPSG:5728'`). This
package does not depend on it; an adapter is a few lines:

```ts
import type { MapBBox, TerrainGrid, TerrainSource } from '@ifc-lite/flood-check';

/** The part of geodata-ch's `TerrainProvider` the adapter uses. */
interface ElevationGridClient {
  elevationGrid(
    bbox: MapBBox,
    options: { resolution: number; signal?: AbortSignal },
  ): Promise<Omit<TerrainGrid, 'sampling'> & { values: Float32Array; hasData: boolean }>;
}
declare const swissAlti3d: ElevationGridClient;

const terrain: TerrainSource = {
  crs: 'EPSG:2056',
  verticalCrs: 'EPSG:5728',
  verticalReference: 'LN02',
  // swissALTI3D, older LiDAR below 2,000 m (1 sigma). Use 0.3 where the area is
  // known to be covered by the new LiDAR generation, and 3 above 2,000 m.
  verticalAccuracy: 0.5,
  async grid(bbox, options) {
    return { ...(await swissAlti3d.elevationGrid(bbox, options)), sampling: 'node' };
  },
};
console.log(terrain.verticalCrs);
```

### The BAFU provider

`createBafuRunoffProvider({ fetch?, timeoutMs?, cache?, cellSize?, baseUrl?, now? })`
reads WMS GetMap from `wms.geo.admin.ch` (no federal service returns the depth
class for a point) and decodes colours **exactly**:

| Class id | Depth | RGB |
| --- | --- | --- |
| `depth-0-0.1` | 0 < h ≤ 0.1 m | 255 189 255 |
| `depth-0.1-0.25` | 0.1 < h ≤ 0.25 m | 223 115 255 |
| `depth-gt-0.25` | h > 0.25 m (open-ended) | 132 0 168 |
| `watercourse` | water, no depth (open-ended from 0) | 0 166 255 |
| `glacier` | not modelled | 222 245 255 |
| transparent | no runoff modelled | — |

The server antialiases polygon edges, so only alpha-255 pixels whose RGB
equals a legend colour are classified; blends stay unclassified and are never
rounded to the nearest class. Opaque colours that are neither a legend colour
nor a blend of two legend colours, in significant numbers, throw
`HazardStyleChangedError`: the style changed and no class can be trusted.
Requests are snapped outward to the cell grid (default 0.5 m) and kept at
9 px or more per side (the server answers HTTP 500 to 1 × 1). PNG decoding
uses `fflate` (MIT), which `@ifc-lite/parser` already ships; no new
third-party dependency was added. A request over 4,096 px per side is refused
(`request-too-large`).

**No data is not "no runoff".** The WMS answers transparent pixels outside
Switzerland and Liechtenstein, and during an outage or reprocessing, exactly as
it does where no runoff is mapped. So:

- `covers(point)` tests the coverage perimeter: Switzerland (the Büsingen and
  Campione enclaves as holes) and Liechtenstein, from swissBOUNDARIES3D
  national boundaries (layer `ch.swisstopo.swissboundaries3d-land-flaeche.fill`,
  © swisstopo), simplified with Douglas-Peucker at 50 m and rounded to whole
  metres, so the boundary is known to 51 m (`scripts/build-coverage.mjs`
  regenerates `src/bafu/coverage-data.ts`). A sample outside, or within 51 m
  of the border, reads `outside-coverage`: no data.
- When the whole raster over the building is transparent, `runFloodCheck`
  calls `confirmRendering()`: one 9 × 9 px request (about 80 bytes) at a
  reference box in Bern, E 2,599,560–2,599,569, N 1,199,720–1,199,729, where
  the map shows flow depth 0–0.1 m in all 81 pixels (recorded 2026-11-15 as
  `test/fixtures/bafu/bern-uniform-9px.png`). It goes through the same cache
  and is made once per provider; a negative answer is not kept. Without a
  confirmation, transparent samples are `unclassified` (`layer-not-confirmed`)
  rather than `no-runoff-mapped`.

## Model facts

`extractModelFacts(store, options)` reads placements, a few representation
entities, properties and containment from the parsed store. No meshing.

- **Georeferencing**: the model's own `IfcMapConversion` (or
  `ePSet_MapConversion`, `IfcRigidOperation`) through the parser's transform
  helpers. It **refuses** (`FloodCheckRefusal`, with a `code`) when there is no
  map conversion, the CRS is geographic or not identifiable as an EPSG code,
  it is not `expectedCrs`, or the Scale is ambiguous (project unit ≠ map unit
  with Scale unset or 1: pass `mapScale: 'schema' | 'unit-bridged'`). The check
  refuses again when the raster or terrain is in another CRS, or when the
  model **states** a vertical datum that is not the terrain's. A stated
  datum is identified as an EPSG vertical CRS (`LN02`, `Landesnivellement
  1902` and `EPSG:5728` all give `EPSG:5728`) and compared with the terrain's
  `verticalCrs` by code; a name that identifies none is refused
  (`vertical-datum-unrecognised`). An unstated datum is recorded as an
  assumption, not refused.
- **Ground storey**: `groundStorey` option, else the storey placed nearest
  project ±0.00 (Swiss convention: ±0.00 is the finished ground floor and
  `OrthogonalHeight` its absolute height); else the lowest storey with a
  warning. The check **refuses** when it is implausible against the terrain
  (see "Height reference" below).
- **Footprint**: `footprint` option (for example a cadastral outline), else
  the outlines of the ground storey's floor slabs (`FootPrint` curve or the
  extruded `Body` profile), else its external walls' axes chained into one
  closed ring (`external-wall-outline`, which keeps courtyards and notches),
  else the hull of those axes (`external-wall-hull`), else the hull of the
  candidates (`candidate-hull`, with a warning). A hull fills courtyards and
  notches, so on a hull footprint no element is reported
  `above-mapped-class-range`; pass a real outline when the model has none.
- **Candidates** and their lowest relevant level:

  | Category | Selected when | Level |
  | --- | --- | --- |
  | `door`, `window` | `IsExternal` on the element or its host wall (an external host wins over the element's own `false`); with neither stated, within 1 m of the outline (kept when no outline can be read at all) | the lower of the placement origin (threshold / sill) and the bottom of the filled opening's body, with a note when they differ by more than 0.3 m (some tools place windows at the head or centre) |
  | `basement-window` | such a window below the ground storey | as `window` |
  | `wall-opening` | unfilled opening (not RECESS) in an external wall | lowest point of its extruded body |
  | `slab-opening` | unfilled opening in a slab at or below the ground storey | the slab's placement |
  | `light-well` | proxy / chamber / civil element / assembly / opening named Lichtschacht, Kellerschacht, light well, saut-de-loup, bocca di lupo, … | placement origin |
  | `stair`, `ramp` | outside the footprint (even when it states `IsExternal = false`, often an authoring default) or `IsExternal`; skipped only when a readable body lies wholly above the ground storey (it leads up); kept when the body cannot be read, since the placement origin may be at the top | `ground-storey-or-terrain`: the check compares the **lower of the ground storey level and the terrain** at each sample, so any mapped depth class there makes it `exposed`; never favourable |
  | `equipment` | in the ground storey or below. IFC4 / IFC4X3 occurrences: `IfcElectricDistributionBoard`, `IfcTransformer`, `IfcElectricGenerator`, `IfcElectricFlowStorageDevice` (batteries), `IfcSwitchingDevice`, `IfcProtectiveDevice`, `IfcCommunicationsAppliance`, `IfcBoiler`, `IfcChiller`, `IfcUnitaryEquipment` (heat pumps), `IfcPump`, `IfcTank`, `IfcTransportElement` ELEVATOR / LIFTINGGEAR. Every schema, and the only way in IFC2X3: `IfcEnergyConversionDevice`, `IfcFlowMovingDevice`, `IfcFlowStorageDevice`, `IfcFlowController` or `IfcFlowTerminal` typed by `IfcTransformerType`, `IfcElectricGeneratorType`, `IfcElectricFlowStorageDeviceType`, `IfcSwitchingDeviceType`, `IfcProtectiveDeviceType`, `IfcBoilerType`, `IfcChillerType`, `IfcUnitaryEquipmentType`, `IfcPumpType`, `IfcTankType` (and, IFC4 on, `IfcCommunicationsApplianceType`, `IfcElectricDistributionBoardType`). IFC2X3 also has `IfcElectricDistributionPoint`; it has no communications-appliance class or type | placement origin (base) |

  Doors, windows and openings more than `aboveGroundScope` (3 m) above the
  ground storey are out of scope. Interior stairs are not entry points.

## The check

For each candidate the map is read on the ground next to it. The hazard model
raised every building footprint by 5 m, so a footprint carries no depth; the
check anchors each element on the outline (its own position when outside, else
the nearest outline point, recording how far it moved as `anchorOffset`) and
samples rings at **2 m and 3 m** in 16 directions, keeping points at least
**1 m** outside the footprint. 2 m clears the 1 m model raster by two cells
and absorbs about 1 m of disagreement between the model's outline and the
footprint the hazard model raised, plus the one-pixel antialiased band; 3 m is
a second chance when the first ring hits such a band.

**Every classified sample is compared with its own terrain and class.** A
shallower class on higher ground can put the water surface higher than a
deeper class lower down (a façade along a sloping street), so no single class
governs. With element level `z`, clearance margin `m` and, per classified
sample `i`, terrain `Ti` and class `(Li, Ui]` (`Ui` unbounded for the
open-ended class and watercourses):

| Outcome | Rule |
| --- | --- |
| `exposed` | some sample has `z ≤ Ti + Li`: the water surface there is above `z` for any depth in the class |
| `open-ended-class` | none is exposed, and some open-ended sample has `z > Ti + Li`: no level can be shown above it |
| `above-mapped-class-range` | every sample has `z > Ti + Ui + m`, and nothing below withholds it |
| `within-class-range` | otherwise: the class ranges cannot decide it |
| `no-runoff-mapped` | every ground sample is transparent, inside the coverage perimeter, and the layer is known to render. **Not "safe"**: the publisher states areas shown unaffected may still be affected |
| `unclassified` | `map-edge-blend`, `outside-raster`, `outside-coverage`, `layer-not-confirmed`, `no-ground-sample`, `excluded-area` or `no-terrain` |

`above-mapped-class-range` states only that: the element level is above the
range of every class the map shows next to it, with the margin to spare. It
says nothing about rarer events or runoff the map does not show. It is
**withheld** (reported as `within-class-range`, the reasons listed in
`favourableWithheldBecause`) when the terrain source states no vertical
accuracy, the level is an upper estimate, any ground sample is unreadable
(default `edgePolicy: 'cannot-clear'`) or lies in an area the map did not
model (glacier), a classified sample has no terrain,
the element had to be moved more than `anchorTolerance` (default 1 m) to
reach the outline (courtyards, notches, interior elements), or the footprint
is a hull. For an entry at terrain (`ground-storey-or-terrain`), `z` is the
lower of the ground storey level and `Ti`.

The sample that decides the outcome is reported with its numbers
(`drivingSample`: point, class, `Ti`, the level compared and the comparison;
also `hazardClass`, `terrainHeight`, `comparison`): the most deeply exposed
sample, the open-ended sample closest to `z`, or the sample with the least room
above its class. `exposed` uses no margin: being flagged is the conservative
side. Below-ground spaces whose floor lies under an exposed entry point (door,
window, opening, light well, stair or ramp; not equipment) and under the
terrain there are listed in `reachableBelowGround` — flagged, not sized.

### Clearance margin

```
m = max(0.5 m, 2 · sqrt(σT² + c² + σG²))
```

| Input | Value | Source |
| --- | --- | --- |
| `σT` terrain, 1 sigma | `TerrainSource.verticalAccuracy` as the source states it. swissALTI3D: 0.3 m (new generation of LiDAR data), 0.5 m (previous generation of LiDAR data, below 2,000 m a.s.l.), 1 to 3 m (stereo correlation, above 2,000 m) | swisstopo, swissALTI3D product page, "Quality" (accuracies are 1 sigma in all three dimensions): https://www.swisstopo.admin.ch/en/height-model-swissalti3d, read 2026-11-15 |
| `c` class resolution | 0.25 m (`classResolution`) | the bounded BAFU depth classes span 0–0.25 m (0–0.1, 0.1–0.25 m; legend and technical report) |
| `σG` georeferencing, 1 sigma | 0.1 m default (`georeferenceVerticalUncertainty`) | a surveyed `OrthogonalHeight` and ground storey are good to a few centimetres; raise it for an estimated one |
| floor | 0.5 m, or `clearanceMargin` when larger | a caller can raise the margin, never lower it below the derived value |

Twice the root-sum-square is a two-sigma bound for independent errors. With
swissALTI3D's 0.5 m: `2 · sqrt(0.25 + 0.0625 + 0.01) = 1.136 m`; with 0.3 m:
`0.806 m`; above 2,000 m with 3 m: `6.03 m`. When the terrain source states no
accuracy, the margin is not sized (`clearanceMargin: null`) and nothing is
reported `above-mapped-class-range`. `result.margin` records the inputs and
`statement` the formula with its numbers.

### Height reference

Every comparison is absolute, so a wrong `OrthogonalHeight`, vertical datum or
ground storey shifts every result the same way (500 m too low makes everything
`exposed`; 40 m too high makes everything look favourable). The check reads
the terrain at **every** ring point of every candidate, and with `Tmin`/`Tmax`
the lowest and highest of those heights it requires the ground storey level
`g` to satisfy

```
Tmin − 1.5 m ≤ g ≤ Tmax + 2.5 m        (heightPlausibility: { below, above })
```

On a hillside the rings see both the uphill and the downhill terrain, so a
walk-out basement (ground floor at the uphill grade, `g` near `Tmax` and
metres above `Tmin`) passes. 2.5 m above allows a raised ground floor
(Hochparterre, up to about 1.5 m) plus 1 m for terrain error; 1.5 m below
allows a ground floor sunk below the lowest adjacent grade by about 1 m plus
0.5 m. Outside the band the check **refuses** with `georeference-implausible`,
stating the numbers and that this indicates a height-reference error in the
model, not flood exposure. The basis is recorded in `result.heightPlausibility`
and the site property set. `runFloodCheck` also refuses
(`georeference-implausible`) when candidates, footprint and rings span more
than `maxPlanExtent` (default 1,000 m): a wrong length unit or map scale.

### Uncertainty budget

- **Terrain**: see the margin table. The hazard model ran on a 2 m resampled
  and smoothed terrain, with paved areas lowered 0.25 m, so its ground is not
  the terrain you sample.
- **Map**: 1 m model raster; the publisher's scale limit is 1:12,500, far
  coarser than the façade-level reading done here. The class is a range, not
  a depth, and the open-ended class has no upper bound at all.
- **Model georeferencing**: a few centimetres for a surveyed
  `IfcMapConversion`; decimetres to metres for an estimated one. Rotation
  errors grow with distance from the origin. The vertical datum, when the
  model does not state it, is assumed equal to the terrain's.
- **Levels**: doors and windows take the lower of their placement origin and
  the bottom of the filled opening where the opening's body is readable;
  without it, a tool that places windows at the head or centre reads high.

## Property sets

`toPropertySets(result, classes)` returns payloads shaped like
`@ifc-lite/create`'s `PropertySetDef`, with lengths in the model's project
unit. No buildingSMART set covers flood or surface runoff and `Pset_` is
reserved, so the names follow the repo's own `IfcLite_` sets:

- **`IfcLite_SurfaceRunoffHazardSite`** (on IfcSite / IfcBuilding):
  `ProviderId`, `Dataset`, `DatasetTitle`, `DatasetDate`, `MetadataUpdated`,
  `RetrievedAt`, `RequestUrl`, `ClassDefinition`, `ReturnPeriodDE/EN`,
  `Licence`, `Attribution`, `LimitsDE/EN`, `DisclaimerDE/EN`, `CaveatDE/EN`,
  `CoordinateReferenceSystem`, `TerrainVerticalReference`,
  `TerrainVerticalCrs`, `VerticalDatumBasis`, `FootprintSource`,
  `GroundStoreyBasis`, `GroundStoreyLevel`, `HeightPlausibilityStatus`,
  `HeightPlausibilityBasis`, `TerrainMinNearBuilding`,
  `TerrainMaxNearBuilding`, `HeightPlausibilityBelow/Above`,
  `ClearanceMargin` (absent when not sized), `ClearanceMarginBasis`,
  `TerrainVerticalAccuracy`, `RasterCellSize`, `RingDistances`,
  `MinOutsideDistance`, `AnchorTolerance`, `EdgePolicy`, `RasterEmpty`,
  `LayerRenderingConfirmed` / `LayerRenderingCheck` (when a check was made),
  `Count_<Outcome>`, `CountReachableBelowGroundSpaces`.
- **`IfcLite_SurfaceRunoffExposure`** (per element): `Outcome`,
  `OutcomeMeaningEN/DE`, `CaveatEN/DE` (screening result from a map not
  intended for building scale; unmapped areas may still be affected; points to
  the site set), `UnclassifiedReason`, `Category`, `SelectedBecause`,
  `HazardClass`, `ClassLowerBound`, `ClassUpperBound` (absent when
  open-ended), `ClassOpenEnded`, `ClassesFound`, `ElementLevel`, `LevelBasis`,
  `LevelIsUpperEstimate`, `ComparedLevel`, `TerrainHeight`,
  `WaterSurfaceLowerBound`, `WaterSurfaceUpperBound`,
  `LevelAboveSurfaceLowerBound`, `LevelAboveSurfaceUpperBound`,
  `ClearanceMargin`, `DrivingSample`, `SamplesCompared`,
  `SamplesOutsideFootprint`, `SamplesUnreadable`, `AnchorOffset`,
  `FavourableWithheldBecause`, `Notes`, `Dataset`, `DatasetDate`,
  `RetrievedAt`, `Attribution`, `SitePropertySet`. A payload read on its own
  therefore still carries the caveat, the source and the dataset date.

## Source and terms

Bundesamt für Umwelt BAFU / Federal Office for the Environment FOEN,
«Gefährdungskarte Oberflächenabfluss / Overland flow map»,
https://www.bafu.admin.ch/en/surface-runoff — technical report:
https://www.bafu.admin.ch/dam/en/sd-web/DEm7R2xCdfPk/gefaehrdungskarte-oberflaechenabfluss-schweiz-technischer-bericht.pdf.
Federal geodata under the geo.admin.ch terms of use, source reference
mandatory; data of the canton of Lucerne carries separate cantonal terms.
The German and English disclaimers (`BAFU_DISCLAIMER`) quote the WMS layer
abstract verbatim (the English one equals the STAC collection description).

## Live smoke

`node packages/flood-check/scripts/live-smoke.mjs [easting northing]` (after
building) makes two small requests (three when the answer is wholly
transparent) and prints the decoded counts and the outcome for a synthetic
building. It is never run by CI.
