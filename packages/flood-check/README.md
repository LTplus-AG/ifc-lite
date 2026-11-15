# @ifc-lite/flood-check

Headless check of a georeferenced building model against a surface-runoff
hazard map: which doors, windows, openings, light wells, external stairs and
ramps, and which technical equipment in the lowest storeys sit below the
mapped water-depth class next to the building.

One provider ships: the Swiss federal **Gefährdungskarte Oberflächenabfluss**
(BAFU, layer `ch.bafu.gefaehrdungskarte-oberflaechenabfluss`). The interfaces
are country-neutral; terrain and anything else comes in through small
interfaces the caller injects.

> **Screening only.** The map is modelled without field verification, ignores
> river flooding, protective structures and culverts, and must not be used at
> scales more detailed than 1:12,500. Areas shown unaffected may still be
> affected. It is not legally binding. Show `BAFU_DISCLAIMER` and
> `BAFU_ATTRIBUTION` with every result.

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
declare const terrain: TerrainSource; // e.g. a swissALTI3D grid client, heights in LN02

const store = await new IfcParser().parseColumnar(bytes);
const facts = extractModelFacts(store, { expectedCrs: 'EPSG:2056' });
const result = await runFloodCheck(facts, createBafuRunoffProvider(), terrain);
for (const r of result.results) console.log(r.candidate.name, r.outcome, r.hazardClass?.id);
const { site, elements } = toPropertySets(result, BAFU_CLASSES);
console.log(site.Name, elements.length, BAFU_ATTRIBUTION, BAFU_DISCLAIMER.de);
```

`checkFloodExposure(facts, raster, terrainSampler)` is the pure core: no I/O.
`runFloodCheck` fetches one raster over the building and the terrain under it,
then calls it.

## Interfaces

- **`HazardProvider`** — `fetchRaster({ bbox, crs, cellSize?, signal? })` returns a
  north-up `ClassifiedHazardRaster`: one class code per cell (`CELL_NO_RUNOFF`,
  `CELL_UNCLASSIFIED`, or `k` for `classes[k-1]`), cell size, top-left origin,
  counts of classified / no-runoff / unclassified cells, and provenance
  (dataset, dataset date, retrieval time, request URL, attribution, licence,
  return-period wording, limits, disclaimer). It declares its `crs`, `extent`
  and `modelCellSize`.
- **`TerrainSource`** — `heightAt(point)` and/or `grid(bbox, { resolution })`,
  with its `crs` and `verticalReference` named (for example `LN02`). A grid
  is a `TerrainGrid` (north-up, heights at cell centres, NaN for no data).
- **`ModelFacts`** — plain data from `extractModelFacts`, or built by hand.

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
third-party dependency was added.

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
  model **states** a vertical datum that is not the terrain's (`LN02`,
  `EPSG:5728`, `Landesnivellement 1902` compare equal). An unstated datum is
  recorded as an assumption, not refused.
- **Ground storey**: `groundStorey` option, else the storey placed nearest
  project ±0.00 (Swiss convention: ±0.00 is the finished ground floor and
  `OrthogonalHeight` its absolute height); else the lowest storey with a
  warning. The check warns when it sits more than 1.5 m from the median
  terrain next to the building.
- **Footprint**: `footprint` option (for example a cadastral outline), else
  the outlines of the ground storey's floor slabs (`FootPrint` curve or the
  extruded `Body` profile), else the hull of its external walls' axes, else
  the hull of the candidates (with a warning).
- **Candidates** and their lowest relevant level:

  | Category | Selected when | Level |
  | --- | --- | --- |
  | `door`, `window` | `IsExternal` on the element or its host wall (an external host wins over the element's own `false`); with neither stated, within 1 m of the outline | placement origin (threshold / sill) |
  | `basement-window` | such a window below the ground storey | placement origin |
  | `wall-opening` | unfilled opening (not RECESS) in an external wall | lowest point of its extruded body |
  | `slab-opening` | unfilled opening in a slab at or below the ground storey | the slab's placement |
  | `light-well` | proxy / chamber / civil element / assembly / opening named Lichtschacht, Kellerschacht, light well, saut-de-loup, bocca di lupo, … | placement origin |
  | `stair`, `ramp` | outside the footprint (or `IsExternal`) in a storey below ground | ground storey level, an **upper estimate**: it can flag but never clear |
  | `equipment` | `IfcElectricDistributionBoard` (2X3: `IfcElectricDistributionPoint`), `IfcTransformer`, `IfcBoiler`, `IfcPump`, `IfcTank`, `IfcTransportElement` ELEVATOR / LIFTINGGEAR, in the ground storey or below | placement origin (base) |

  Doors, windows and openings more than `aboveGroundScope` (3 m) above the
  ground storey are out of scope. Interior stairs are not entry points.

## The check

For each candidate the map is read on the ground next to it. The hazard model
raised every building footprint by 5 m, so a footprint carries no depth; the
check anchors each element on the outline (its own position when outside, else
the nearest outline point) and samples rings at **2 m and 3 m** in 16
directions, keeping points at least **1 m** outside the footprint. 2 m clears
the 1 m model raster by two cells and absorbs about 1 m of disagreement between
the model's outline and the footprint the hazard model raised, plus the
one-pixel antialiased band; 3 m is a second chance when the first ring hits
such a band. The most severe class found governs, and the terrain height is
the **highest** among the samples showing it (conservative on slopes).

With terrain `T`, class `(L, U]`, element level `z` and clearance margin `m`
(default **0.5 m**):

| Outcome | Rule |
| --- | --- |
| `exposed` | `z ≤ T + L`: the water surface is above `z` for any depth in the class |
| `clear` | `z > T + U + m`: below `z` with the margin to spare |
| `within-class-range` | `T + L < z ≤ T + U + m`: a class cannot decide it |
| `open-ended-class` | `U` unbounded and `z > T + L`: no level can be cleared |
| `no-runoff-mapped` | every ground sample is transparent (which does not mean unaffected) |
| `unclassified` | `map-edge-blend`, `outside-raster`, `no-ground-sample`, `excluded-area` or `no-terrain` |

`exposed` uses no margin: being flagged is the conservative side. A `clear`
is downgraded to `within-class-range` when the level is an upper estimate, or
(default `edgePolicy: 'cannot-clear'`) when some ground samples were
unreadable. Every result carries the numbers: `T`, the class bounds, `T + L`,
`T + U`, `z − (T + L)`, `z − (T + U)`, the margin, the governing sample and the
sample counts. Below-ground spaces whose floor lies under an exposed opening
(and under the terrain there) are listed in `reachableBelowGround` — flagged,
not sized.

### Uncertainty budget

- **Terrain**: swissALTI3D is stated at 0.3 m (newer LiDAR) to 0.5 m (older
  LiDAR below 2,000 m), 1 sigma; 1–3 m in stereo-correlated areas above
  2,000 m. The hazard model ran on a 2 m resampled and smoothed version, with
  paved areas lowered 0.25 m, so its ground is not the terrain you sample.
- **Map**: 1 m model raster; the publisher's scale limit is 1:12,500, far
  coarser than the façade-level reading done here. The class is a range, not
  a depth, and the open-ended class has no upper bound at all.
- **Model georeferencing**: a few centimetres for a surveyed
  `IfcMapConversion`; decimetres to metres for an estimated one. Rotation
  errors grow with distance from the origin. The vertical datum, when the
  model does not state it, is assumed equal to the terrain's.
- **Levels**: placement origins stand for thresholds and sills in the usual
  authoring convention; a tool that places windows at the head or centre will
  read high (and could clear wrongly).

The default margin of 0.5 m covers 1 sigma of the older terrain data plus
centimetre-level georeferencing; raise it for estimated georeferencing.

## Property sets

`toPropertySets(result, classes)` returns payloads shaped like
`@ifc-lite/create`'s `PropertySetDef`, with lengths in the model's project
unit. No buildingSMART set covers flood or surface runoff and `Pset_` is
reserved, so the names follow the repo's own `IfcLite_` sets:

- **`IfcLite_SurfaceRunoffHazardSite`** (on IfcSite / IfcBuilding):
  `ProviderId`, `Dataset`, `DatasetTitle`, `DatasetDate`, `MetadataUpdated`,
  `RetrievedAt`, `RequestUrl`, `ClassDefinition`, `ReturnPeriodDE/EN`,
  `Licence`, `Attribution`, `LimitsDE/EN`, `DisclaimerDE/EN`,
  `CoordinateReferenceSystem`, `TerrainVerticalReference`,
  `VerticalDatumBasis`, `FootprintSource`, `GroundStoreyBasis`,
  `GroundStoreyLevel`, `ClearanceMargin`, `RasterCellSize`, `RingDistances`,
  `MinOutsideDistance`, `EdgePolicy`, `Count_<Outcome>`,
  `CountReachableBelowGroundSpaces`.
- **`IfcLite_SurfaceRunoffExposure`** (per element): `Outcome`,
  `UnclassifiedReason`, `Category`, `SelectedBecause`, `HazardClass`,
  `ClassLowerBound`, `ClassUpperBound` (absent when open-ended),
  `ClassOpenEnded`, `ElementLevel`, `LevelBasis`, `LevelIsUpperEstimate`,
  `TerrainHeight`, `WaterSurfaceLowerBound`, `WaterSurfaceUpperBound`,
  `LevelAboveSurfaceLowerBound`, `LevelAboveSurfaceUpperBound`,
  `ClearanceMargin`, `GoverningSample`, `SamplesOutsideFootprint`,
  `SamplesUnreadable`, `Notes`, `Dataset`, `RetrievedAt`.

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
building) makes two small requests and prints the decoded counts and the
outcome for a synthetic building. It is never run by CI.
