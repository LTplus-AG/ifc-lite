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
> dataset date. The check withholds every favourable outcome the data does not
> support. **The model's height reference cannot be verified from the hazard
> map**: the check refuses only gross height errors, withholds favourable
> outcomes when the ground-storey doors do not sit plausibly on the terrain
> next to them, and states in every result and in the site property set the
> height error it cannot detect (see [Height reference](#height-reference)).

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
confirm the layer renders when no cell of that raster shows a mapped class
(only transparent or unreadable edge pixels), and calls it
with the raster's coverage combined with the provider's perimeter. With a
`buildings` source (`BuildingFootprintSource`: `footprints(bbox)` returns
other buildings' rings in the provider CRS, with provenance and a
`complete` flag; the answer covers the box asked for unless it states its own
`extent`, and `OtherBuildingFootprints` passed directly must state one) it also fetches the footprints of the buildings around.

## Interfaces

- **`HazardProvider`** — `fetchRaster({ bbox, crs, cellSize?, signal? })` returns a
  north-up `ClassifiedHazardRaster`: one class code per cell (`CELL_NO_RUNOFF`,
  `CELL_UNCLASSIFIED`, or `k` for `classes[k-1]`), cell size, top-left origin,
  counts of classified / no-runoff / unclassified cells, and provenance
  (dataset, dataset date, retrieval time, request URL, attribution, licence,
  return-period wording, limits, disclaimer). It declares its `crs`, `extent`
  and `modelCellSize`, and optionally `covers(point)` (its coverage
  perimeter: `true`, `false`, or `null` when too close to tell). Every raster
  carries its own **required** `covers`: a `CoverageTest` or the explicit
  value `'everywhere'` and
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
- When no cell of the raster over the building shows a mapped class (it is
  transparent, or transparent with unreadable edge pixels), `runFloodCheck`
  calls `confirmRendering()`: one 9 × 9 px request (about 80 bytes) at a
  reference box in Bern, E 2,599,560–2,599,569, N 1,199,720–1,199,729, where
  the map shows flow depth 0–0.1 m in all 81 pixels, and all 81 must come back classified to confirm (a partially rendered reference does not) (recorded 2026-11-15 as
  `test/fixtures/bafu/bern-uniform-9px.png`). A confirmation vouches only for
  a raster fetched **within 5 minutes** of its reference response
  (`CONFIRMATION_MAX_AGE_MS`; the service may stop rendering at any time): the
  provider reuses a positive answer for at most 5 minutes and asks again after
  any negative or failed one, and the check compares the two retrieval times.
  Concurrent checks share one reference request, which runs under no caller's
  signal; each caller waits under its own, so one caller's abort neither
  cancels nor poisons another's confirmation.
  Without such a confirmation, transparent samples are `unclassified`
  (`layer-not-confirmed`) rather than `no-runoff-mapped`. The result records
  the reference's retrieval time (`provenance.renderingCheckedAt`,
  `layerCheck.confirmation.retrievedAt`).
- The `cache` hook stores a response only once it decodes at the requested
  size and shows a mapped class, and serves only such entries: a transparent
  answer may be an outage and is always fetched again, and a malformed one is
  never kept. A cached reference response is used only within 5 minutes of
  its retrieval, so a caller's long-lived cache cannot keep an old
  confirmation alive; a building raster that shows classes is served from it
  with its first retrieval time, as before. `timeoutMs`, `maxPixels` and
  `cellSize` must be finite and positive (`RangeError` otherwise).

## Model facts

`extractModelFacts(store, options)` reads placements, a few representation
entities, properties and containment from the parsed store. No meshing.

- **Georeferencing**: the model's own `IfcMapConversion` (or
  `ePSet_MapConversion`, `IfcRigidOperation`) through the parser's transform
  helpers. It **refuses** (`FloodCheckRefusal`, with a `code`) when there is no
  map conversion, the CRS is geographic or not identifiable as an EPSG code,
  it is not `expectedCrs`, or the Scale is ambiguous (project unit ≠ map unit
  with Scale unset or 1: pass `mapScale: 'schema' | 'unit-bridged'`), or the
  Scale is 0, negative or not finite (`georeference-implausible`). The check
  refuses again when the raster or terrain is in another CRS, or when the
  model **states** a vertical datum that is not the terrain's. A stated
  datum is identified as an EPSG vertical CRS (`LN02`, `Landesnivellement
  1902` and `EPSG:5728` all give `EPSG:5728`) and compared with the terrain's
  `verticalCrs` by code; a name that identifies none is refused
  (`vertical-datum-unrecognised`). An unstated datum is recorded as an
  assumption, not refused.
- **Ground storey**: **state it with the `groundStorey` option** (express
  id, GlobalId or Name; a Name shared by several storeys, for example "EG" in
  two buildings, is refused as `ambiguous-building`, listing them, so pass a
  GlobalId or express id). Without it, the storey placed nearest project ±0.00
  (Swiss convention: ±0.00 is the finished ground floor and
  `OrthogonalHeight` its absolute height), else the lowest storey, is taken
  with a warning; such a pick may be the basement, so it is a guess: the height
  reference stays unconfirmed and no exclusion rests on its level. The check **refuses** when it is implausible against the terrain
  (see "Height reference" below).
- **Footprint**: `footprint` option (for example a cadastral outline; a point
  ring lying wholly inside the others is a courtyard, open ground for every
  distance and outline test, and elements facing it get no reassuring
  outcome, `courtyard-ring`), else
  the outlines of the ground storey's floor slabs (`FootPrint` curve or the
  extruded `Body` profile; `slab-outline`, or `slab-outline-voids-filled`
  when the slab has holes whose shape is not read: a `FootPrint` of more than
  one curve, or a Boolean cut other than a vertical prism through the whole
  slab and wholly inside it: a notch at the edge, a half space or clipping,
  an intersection). A through cut is read as a hole and classified below; a
  shallow cut (a recess) leaves slab material under it and is no hole. The inner curves of a slab profile are
  read as holes, also under a `FootPrint`: one under 1 m² stays closed; one
  wholly roofed (every point of a grid clipped to the hole and just inside
  each edge and corner lies under a slab, a roof, a roofing covering, a
  window lying flat or a plate more than 1 m higher, read in full, outside
  its holes) is interior (a shaft, a
  stair opening, a floor area under the building): filled, noted, no
  condition; any other, a partly roofed one included, is open to the sky, a
  courtyard: a hole in the prepared footprint (`courtyardRings`,
  quality `courtyard-ring`), guarded only for the elements next to it. Else its external walls' axes
  chained into one closed ring (`external-wall-outline`, which keeps
  courtyards and notches), else the hull of those axes (`external-wall-hull`),
  else the hull of the candidates (`candidate-hull`, with a warning). A hull
  or a slab outline with filled voids fills courtyards and notches, so on it
  no element gets a reassuring outcome; pass a real outline when the model
  has none. When a ground-storey floor slab has no readable outline (a Brep,
  a Boolean UNION) while others do, the footprint misses its area:
  `footprint.partial` is set, the slab is in `skipped`, a warning says so and
  no element gets a reassuring outcome (`partial-footprint`).
  **Bodies given as `IfcMappedItem`** (how Revit exports doors, windows and
  equipment) are read through their `RepresentationMap`, placed by
  `MappingTarget · MappingOrigin` (the geometry engine's order; the target's
  axes follow `IfcBaseAxis`, so an omitted Axis2 can mirror), with a uniform
  scale applied; nested maps are followed up to 8 deep, a map met again is a
  cycle, and a non-uniform scale is refused: those items count as unreadable.
  **Every geometry reader reports what it could not read**
  (`src/model/outline.ts`): bodies, slab outlines and wall axes are read item
  by item, every item, and each read returns the items present and the items
  read; a slab whose body holds two extrusions gives two rings, and one with
  an unreadable item is `partial`. A Boolean DIFFERENCE is read through its
  outer operand: a supported through cut becomes a hole; an unsupported cut
  marks the slab outline as voids-filled.
  **The footprint's quality is one record that only accumulates**
  (`src/model/footprint.ts`, `footprint.quality`): every source tried that
  could not be read, or only in part (a slab, an external wall's placement
  or axis), and every condition met (filled voids, a courtyard ring, a
  partial outline, a hull) stays recorded through every later fallback, and
  the worst of them is `quality.worst` (`complete` < `voids-filled` <
  `oversized` < `courtyard-ring` < `partial` < `hull`; site set
  `FootprintQuality`; each condition's evidence in `quality.notes`). A
  fallback supplies geometry but cannot upgrade the quality: a wall loop
  round part of a building whose slab cannot be read is still `partial`.
  The finished footprint is checked against the building: an external
  ground-storey wall whose axis runs more than 1 m outside it, or a door,
  window or opening placed more than 1 m outside it, makes it `partial` (that
  element is kept, never interior); an external wall axis more than 1 m
  inside it makes it `oversized` (a podium or forecourt slab), which counts
  as a hull. Every source walked for the footprint or this wall check and not
  used is recorded once with why (`quality.unreadable`) and makes it
  `partial`: a slab that cannot be read or only in part, a slab ring under
  1 m², an external wall whose placement or axis cannot be read. An external
  wall with no `Axis` representation at all is noted, not marked partial: it
  only cannot cross-check the outline.
  **One prepared footprint for every question** (`src/region.ts`): the
  rings are prepared once (courtyards as holes, seams and narrow gaps
  closed), and the inside test, the signed distance, the closest outline
  point, the courtyard guard, the façade test, the descent rule, the quality
  checks and the check's sampling are all functions of that one object;
  `src/geom.ts` keeps only generic polygon primitives, so no caller can ask
  raw rings a different question. A boundary point is outline only if open ground reaches
  beyond it (a disc of radius 0.38 m, 0.55 m out, outside the building, with
  open ground all the way to it). So the seam where two slabs meet, and a gap
  between slabs narrower than about 0.9 m (under an interior wall), are
  inside the building: an element there is anchored on the real façade, the
  offset is reported (`anchor-moved`), and the façade test measures its
  distance to that outline; a passage 1 m wide or wider stays open ground.
  The footprint's quality notes record closed gaps. A courtyard ring exists
  only in a given footprint (slab outlines and wall loops are material: a
  slab lying within another, a finish on the structure, is no hole): a ring
  whose whole boundary lies inside the union of the others (its edges, not
  only its vertices). It is open ground everywhere: for the signed distance,
  the outline, the façade test and the descent rule, so a ramp in a courtyard
  is outside the building; the courtyard guard applies when the anchor is
  taken on it or it is the nearest boundary. A given `footprint` must have
  rings of 3 or more finite points, at least one enclosing 1 m² or more
  (`RangeError` otherwise); a smaller inner ring is accepted, and, being
  below the closing scale, is closed, with a note.
  A slab ring enclosing less than 1 m² is not used for the outline: the slab
  is listed as a source not used (not in `fromElements`) and the footprint is
  partial. With no `IfcBuildingStorey` nothing says which slabs are at ground
  level: every one is taken and the footprint is partial, never complete.
- **Building**: the footprint is one building's outline, so only the
  elements of the **ground storey's building** are checked (pass
  `groundStorey` to choose another). An element of another building would be
  sampled next to itself, often inside that building, where the map shows no
  depth because the hazard model raised every building, and would read as
  `no runoff mapped`. When the file has several `IfcBuilding`s, the result
  names the checked one (`buildingScope.checked`) and every other one with the
  number of candidate elements found in it (`buildingScope.notChecked`; those
  elements are also in `skipped`), with a warning; façade elements there that
  state no `IsExternal` are not even counted, since they are tested against
  the checked building's outline. Run the check once per building. With
  several buildings and no ground storey placed in one of them, it
  **refuses** (`ambiguous-building`).
- **Candidates** and their lowest relevant level:

  | Category | Selected when | Level |
  | --- | --- | --- |
  | `door`, `window` | `IsExternal` on the element or its host (the wall its opening voids, else its decomposition parent; any class, read from its `Pset_<Class>Common`; an external host wins over the element's own `false`); with neither stated, within 1 m of the outline (kept when no outline can be read at all) | the lowest of the placement origin (threshold / sill, by the schema), its own body's bottom and the filled opening's body's bottom, with a note when placement and hole differ by more than 0.3 m (some tools place windows at the head or centre); at the hole's plan centre when readable (a filling may be placed at its wall's origin) |
  | `basement-window` | such a window below the ground storey | as `window` |
  | `wall-opening` | unfilled opening (not RECESS) in an external wall | lowest point of its body, at its plan centre; with no body, its placement as an upper estimate |
  | `slab-opening` | unfilled opening in a slab at or below the ground storey | the slab's placement |
  | `light-well` | proxy / chamber / civil element / assembly / opening named Lichtschacht, Kellerschacht, light well, saut-de-loup, bocca di lupo, … | the lower of the placement origin and its body's bottom, at the body's plan centre; with no body, its placement as an upper estimate (a light well's placement has no defined height) |
  | `stair`, `ramp` | outside the footprint — by placement, by any body corner, or, with no fully readable body, by a placement within 1 m of the outline (even when it states `IsExternal = false`, often an authoring default) — or `IsExternal`; skipped only when a readable body lies wholly at or above the ground storey (1 cm tolerance; it leads up); kept when the body cannot be read, or only partly (an unreadable item, a Boolean UNION), since the placement origin may be at the top | `ground-storey-or-terrain`: the check compares the **lower of the ground storey level and the terrain** at each sample, so any mapped depth class there makes it `exposed`; never favourable |
  | `equipment` | in the ground storey or below. IFC4 / IFC4X3 occurrences: `IfcElectricDistributionBoard`, `IfcTransformer`, `IfcElectricGenerator`, `IfcElectricFlowStorageDevice` (batteries), `IfcSwitchingDevice`, `IfcProtectiveDevice`, `IfcCommunicationsAppliance`, `IfcBoiler`, `IfcChiller`, `IfcUnitaryEquipment` (heat pumps), `IfcPump`, `IfcTank`, `IfcTransportElement` ELEVATOR / LIFTINGGEAR (or no stated kind). Every schema, and the only way in IFC2X3: `IfcEnergyConversionDevice`, `IfcFlowMovingDevice`, `IfcFlowStorageDevice`, `IfcFlowController` or `IfcFlowTerminal` typed by `IfcTransformerType`, `IfcElectricGeneratorType`, `IfcElectricFlowStorageDeviceType`, `IfcSwitchingDeviceType`, `IfcProtectiveDeviceType`, `IfcBoilerType`, `IfcChillerType`, `IfcUnitaryEquipmentType`, `IfcPumpType`, `IfcTankType` (and, IFC4 on, `IfcCommunicationsApplianceType`, `IfcElectricDistributionBoardType`). IFC2X3 also has `IfcElectricDistributionPoint`; it has no communications-appliance class or type | placement origin (base) |

  **Level, position and their quality** come from one function
  (`locate` in `src/model/locate.ts`), which also holds the only reader of
  placements and bodies in candidate selection. A body is read as a count of
  solid items and how many of them could be read, so "no body", "partly
  readable" and "wholly unreadable" stay apart. The level is `exact` only
  when every source that could lower it or move the position was readable
  and used. It is an **upper estimate** — it can flag but never clear
  (`level-upper-estimate`) — whenever the element's own body or the body of
  the opening it fills exists but cannot be read, in whole or in part (a
  Brep, an unreadable `IfcMappedItem`, a Boolean UNION), or is absent where it
  alone defines the level (an opening without a body; a light well without one).
  Stairs and ramps are always upper estimates (entry at the terrain). An
  element with no readable placement is not placed: it is skipped and named
  in a warning. **A placement alone is never exact**: a door or window is
  `exact` only when its own body or the body of the opening it fills was read
  (a tool may place it at its head), and equipment only when its body was;
  with neither, the level is an upper estimate and the position uncertain. A
  model whose doors have no readable geometry therefore cannot confirm its
  height reference, so nothing in it is reassured; it can still be flagged
  as exposed.

  Doors, windows and openings more than `aboveGroundScope` (3 m) above the
  ground storey are out of scope, judged by their corrected level (a window
  placed at its head is in scope when its opening reaches down into it). Only a
  **proven lowest possible level** (`lowest`, returned by `locate` with the
  level) above the scope excludes: the level itself when it is exact; for a
  door or window whose level is an upper estimate, its placement minus its
  `OverallHeight` (which covers a placement at the head); for an opening,
  that bound of the door or window filling it. With no proven bound (an
  unreadable body and no stated height) the element is kept. A storey is
  never proof of height. With a partial
  footprint, an element that states no `IsExternal` and lies outside the
  readable rings is kept (it may stand in the missing part's façade).
  Interior stairs are not entry points.

  **How they are selected** (`src/model/candidates.ts`): one walk lists every
  element of these classes (doors, windows, openings, light wells, stairs,
  ramps and their flights, equipment), and each gets exactly **one verdict**
  from its rule (`src/model/candidate-rules.ts`), from its own data only: a
  candidate, or a skip with the reason (interior, out of scope, leads up,
  RECESS, a transport element of another kind, no placement). Relations are
  then resolved from those verdicts, never by one rule deciding for another
  element: a candidate in a building that is not checked becomes a skip
  naming that building; an opening is reported through its door or window
  only when that door or window **is** a candidate (otherwise, for example
  when the door cannot be placed or is a proxy, the hole keeps its own
  verdict); a flight is reported through its stair or ramp only when that
  stair or ramp **is** a candidate, and otherwise keeps its own verdict. The candidate and skipped lists are built in one place from the
  one verdict per element, so every element is in exactly one of them; the
  facts record the count walked (`coverage`), and both the extraction and the
  check fail loudly if candidates plus skipped stop adding up to it.

  A rule that would rest on unreadable data keeps the element instead: an
  opening filled by something other than a door or window is a hole, an
  `IfcTransportElement` with no stated kind is kept, an opening with no host
  is tested against the outline, and an opening or filled opening whose body
  is only partly readable gets an upper-estimate level. Elements that cannot
  be placed are named in a warning.

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
| `above-mapped-class-range` | every sample has `z > Ti + Ui + m + a` (`a`: the height-reference allowance), and no condition below withholds it |
| `within-class-range` | otherwise: the class ranges cannot decide it |
| `no-runoff-mapped` | every ground sample is transparent, and no condition below withholds it. **Not "safe"**: the publisher states areas shown unaffected may still be affected |
| `unclassified` | `map-edge-blend`, `outside-raster`, `outside-coverage`, `layer-not-confirmed`, `no-ground-sample`, `excluded-area`, `no-terrain`, or a withheld `no-runoff-mapped`: `anchor-moved`, `hull-footprint`, `courtyard-ring`, `partial-footprint`, `height-reference-unconfirmed`, `level-upper-estimate`, `margin-not-sized`, `other-building`, `other-buildings-unknown`, `position-uncertain` |

`above-mapped-class-range` states only that: the element level is above the
range of every class the map shows next to it, with the margin to spare. It
says nothing about rarer events or runoff the map does not show. For an entry
at terrain (`ground-storey-or-terrain`), `z` is the lower of the ground storey
level and `Ti`.

**The two reassuring outcomes are guarded by the same conditions.** Any one of
them downgrades `above-mapped-class-range` to `within-class-range` and
`no-runoff-mapped` to `unclassified` with the condition's reason; every
condition that applies is listed in `favourableWithheldBecause`. `exposed`
and `open-ended-class` are never withheld (they are the conservative side);
`within-class-range` is not reassuring. The same table is in `evaluate.ts`.

| Condition | `above-mapped-class-range` becomes | `no-runoff-mapped` becomes |
| --- | --- | --- |
| terrain source states no vertical accuracy | `within-class-range` | `unclassified` (`margin-not-sized`) |
| level is an upper estimate | `within-class-range` | `unclassified` (`level-upper-estimate`) |
| the position is uncertain (`positionIsUncertain`: read from part of a body, or from a clipped body's outer operand) | `within-class-range` | `unclassified` (`position-uncertain`) |
| a ground sample is an antialiased edge pixel | `within-class-range` | `unclassified` (`map-edge-blend`) |
| a ground sample is off the raster | `within-class-range` | `unclassified` (`outside-raster`) |
| a ground sample is outside (or too near) the coverage perimeter | `within-class-range` | `unclassified` (`outside-coverage`) |
| a ground sample lies in an area the map did not model (glacier) | `within-class-range` | `unclassified` (`excluded-area`) |
| the element was moved more than `anchorTolerance` (1 m) to reach the outline | `within-class-range` | `unclassified` (`anchor-moved`) |
| the footprint fills courtyards (`external-wall-hull`, `candidate-hull`, `slab-outline-voids-filled`) or reaches beyond the building's external walls (`oversized`: a podium or forecourt slab) | `within-class-range` | `unclassified` (`hull-footprint`) |
| the footprint is partial: a footprint source tried could not be read (a ground-storey floor slab's outline, an external wall's placement or axis), even when a fallback supplied the outline, or an external wall or a façade element stands more than 1 m outside it, or (hand-built facts) the footprint has no rings, so an element in the missing area reads as outside and is sampled inside the building | `within-class-range` | `unclassified` (`partial-footprint`) |
| the anchor was taken on, or the element's nearest footprint boundary is, a courtyard ring (a given footprint's ring whose whole boundary lies inside the union of the others): the courtyard is open ground and is sampled, so a mapped class there flags the element; when it shows none the ground in front may still be a narrow light shaft or a ring the caller meant otherwise | `within-class-range` | `unclassified` (`courtyard-ring`) |
| height reference unconfirmed (see below) | `within-class-range` | `unclassified` (`height-reference-unconfirmed`) |
| no cell of the raster shows a mapped class and the layer is not confirmed to render (no positive confirmation fetched within 5 minutes of the raster) | (no class to compare) | `unclassified` (`layer-not-confirmed`) |
| a classified sample has no terrain height | `within-class-range` | (no classified sample) |
| clearance exceeds `m` but not `m + a` | `within-class-range` | (no comparison) |
| a ground sample lies inside another building (`otherBuildings`), which the hazard model raised | `within-class-range` | `unclassified` (`other-building`) |
| a transparent ground sample, and no complete source of other buildings' footprints was supplied | `within-class-range` | `unclassified` (`other-buildings-unknown`) |

**Transparent counts as "no runoff" only with proof that it is open
ground.** The hazard model raised every building, so a transparent pixel inside
another building (an attached garage, a neighbour not in the model) means "not
modelled". Without a complete source of other buildings' footprints
(`otherBuildings`, or `runFloodCheck`'s `buildings` source), or for a
sample outside that source's stated `extent`, **the check can
flag exposure, and can say "above the mapped class range" only where every
ground sample shows a class; it never says "no runoff mapped".** `exposed` and
`open-ended-class` are unaffected. Each ring is validated like the footprint
(3 or more finite points, an area, no repeated vertex, not wholly outside the
`extent`, which catches swapped coordinates); one invalid ring makes the
source not complete (`otherBuildings.rejected` in the result says why). A
complete source with no rings and an extent is open country.

**Every decision and the completeness it consults.** Each place where an
element is excluded, classed as interior or out of scope, or given a
reassuring outcome, with the completeness facts it reads. The standing rule:
an exclusion whose input is incomplete keeps the element (as an
upper-estimate candidate where its level is in doubt); a reassuring outcome
whose input is incomplete is withheld with the reason.

| Decision | Where | Consults |
| --- | --- | --- |
| not placed (skipped, named in a warning) | `locate` | the element's placement |
| out of scope (`aboveGroundScope` above the ground storey) | `scopeExclusion` | the proven lower bound (`locate`'s `lowest`: the exact level, placement minus `OverallHeight` for a door or window, the filling's bound for an opening; none: kept), the ground storey's basis (a guessed one excludes nothing); never the storey |
| not in the façade (no `IsExternal`, beyond 1 m of the outline) | `facadeReason` | never when more than 1 m OUTSIDE the footprint (kept, footprint marked partial); otherwise `IsExternal` of element and host (the host: the opening's, else the decomposition parent; `IsExternal` from the `Pset_<Class>Common` of the class or any supertype, so any host class is read), the position's certainty (`locate`: read from part of a body, a placement standing in for a hole, or a door or window placement with no readable geometry: kept), the footprint's quality (hull, filled voids: kept; partial: kept outside the readable rings), no footprint at all (kept) |
| interior stair or ramp | `descentVerdict` | `IsExternal`, placement and every body corner, body completeness, the footprint's quality (hull, filled voids: kept; partial: outside counts as outside) |
| a stair or ramp leads up (skipped) | `descentEvidence` | body completeness (a complete body only), the ground storey's basis (a guessed one excludes nothing) |
| a slab opening above the ground storey | `openingVerdict` | the host slab's placement (unplaced: kept, upper estimate), the ground storey's basis |
| equipment above the ground storey | `equipmentVerdict` | its storey may include it (ground storey or below); exclusion needs the proven lower bound (`lowest`) above the scope; the ground storey's basis |
| a transport element of another kind | `equipmentVerdict` | its stated kind (an unstated kind is kept) |
| RECESS opening | `openingVerdict` | its stated predefined type |
| reported through its door, window or stair | `selectCandidates` | that element's verdict (only a candidate reports for another) |
| in a building that is not checked | `selectCandidates`, `scopeToBuilding` | the ground storey's building (several buildings and none placed: refused); named and counted in the result |
| `above-mapped-class-range`, `no-runoff-mapped` | `evaluateCandidate` | every condition of the withhold table above: terrain accuracy, level quality, edge / off-raster / out-of-coverage (the raster's own `covers`, required) / excluded samples, other buildings' footprints (supplied and complete), anchor offset, the footprint's quality record (hull, filled voids, partial) and courtyard rings, the height reference (a known, not guessed, ground storey; doors agreeing within the margin), the layer confirmation and its age, terrain at classified samples, the clearance allowance (the highest ground-storey door) |


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
| `c` class resolution | 0.25 m (`classResolution`; may only be raised) | the bounded BAFU depth classes span 0–0.25 m (0–0.1, 0.1–0.25 m; legend and technical report) |
| `σG` georeferencing, 1 sigma | `georeferenceVerticalUncertainty` as the caller states it; **0.5 m when not stated** | nothing in a model shows whether its `OrthogonalHeight` was surveyed, so the default assumes an estimated one (decimetres to metres). A caller who knows the map conversion is surveyed states it, for example 0.05 m; `result.margin.georeferenceBasis` records `stated-by-caller` or `default-not-surveyed` |
| floor | 0.5 m, or `clearanceMargin` when larger | a caller can raise the margin, never lower it below the derived value |

Twice the root-sum-square is a two-sigma bound for independent errors. With
the default `σG = 0.5 m`: swissALTI3D's 0.5 m gives `2 · sqrt(0.25 + 0.0625 +
0.25) = 1.5 m`, 0.3 m gives `1.269 m`, 3 m above 2,000 m gives `6.10 m`. With a
stated surveyed `σG = 0.1 m`: `1.136 m` and `0.806 m`. When the terrain source states no
accuracy, the margin is not sized (`clearanceMargin: null`) and nothing is
reported `above-mapped-class-range`. `result.margin` records the inputs and
`statement` the formula with its numbers.

### Height reference

Every comparison is absolute, so a wrong `OrthogonalHeight`, vertical datum or
ground storey shifts every result the same way (500 m too low makes everything
`exposed`; a few metres too high makes elements look favourable). **The hazard
map carries no heights, so the model's height reference cannot be verified
from it.** The check catches what contradicts the terrain, in two steps.

**Building level: refusal for gross errors.** The terrain is read along the
**whole footprint outline** (2 m outside it, every 2 m) and at every ring point
of every candidate. With `Tmin`/`Tmax` the lowest and highest of those heights
the ground storey level `g` must satisfy

```
Tmin − 1.5 m ≤ g ≤ Tmax + 2.5 m        (heightPlausibility: { below, above })
```

Because the outline is sampled all round, a hillside building is judged
against its uphill and downhill terrain whichever side its candidates are on:
a walk-out basement and a ground floor at the downhill grade both pass. 2.5 m
above allows a raised ground floor (Hochparterre, up to about 1.5 m) plus 1 m
for terrain error; 1.5 m below allows a ground floor sunk about 1 m below the
lowest grade plus 0.5 m. Outside the band the check **refuses** with
`georeference-implausible`, giving `g`, the lowest and highest terrain with
their positions, and what to check (the map conversion's `OrthogonalHeight`
against the surveyed height of the project origin, the vertical datum, the
storey taken as ground storey). A wider `heightPlausibility` turns a refusal
into results, but then the height reference counts as unconfirmed.

On sloping ground this band spans the whole slope, so it only catches gross
errors: on a 10 m slope, a model up to about 12 m too high passes it.

**Entry level: no favourable outcome without a plausible entry.** Each
ground-storey door with an exact level at a proven position (not an upper
estimate, a lower bound or an uncertain position) on the outline must sit at most `entryAbove` (2.5 m; may
only be lowered) above the terrain next to it (the median of its own ground
samples). If one does not, there is no such door, the ground storey is not
identified or was not stated by the caller (**guessed**: by the ±0.00
convention, the lowest storey, or none: it may be the basement, whose doors
lie at the terrain of a sunken yard or below it), the ground-storey doors
**disagree** about their height above the terrain next to them by more than
the margin (a sunken patio door next to a front door), no terrain was found,
or a refusal band or `maxPlanExtent` was widened, the height reference is
**unconfirmed**: no element anywhere is
reported `above-mapped-class-range` or `no-runoff-mapped`
(`result.heightReference.unconfirmedBecause` says why). Elements on upper
storeys are always far above the terrain, so they never confirm the
reference; they depend on the ground-storey doors like every other element.

If every door passes, the height of the **highest** ground-storey door above
its adjacent terrain, `a = max(0, max hᵢ)`, is the **allowance**: a raised
threshold and a model placed that much too high look the same, so every
favourable outcome needs `a` more clearance than the margin. A door at grade gives `a ≈ 0`; a model placed
2.4 m too high on flat ground gives `a = 2.4 m`.

**Residual risk**, stated in words with this run's numbers in every result
(`residualRisk`), in `result.heightReference.residualRisk`, in the warnings
and in the site set (`ResidualRiskEN/DE`): a height error of up to `entryAbove`
relative to the terrain next to the ground-storey doors is not detectable; the
allowance covers a model placed too high by up to `a`; a larger error would
put every ground-storey door below the terrain next to it, which is the only
case it goes undetected. When the reference is unconfirmed, the statement says so and gives the
building-level band that was applied.

`runFloodCheck` also refuses (`georeference-implausible`) when candidates,
footprint and rings span more than `maxPlanExtent` (default 1,000 m): a wrong
length unit or map scale.

### Uncertainty budget

- **Terrain**: see the margin table. The hazard model ran on a 2 m resampled
  and smoothed terrain, with paved areas lowered 0.25 m, so its ground is not
  the terrain you sample.
- **Map**: 1 m model raster; the publisher's scale limit is 1:12,500, far
  coarser than the façade-level reading done here. The class is a range, not
  a depth, and the open-ended class has no upper bound at all.
- **Model georeferencing**: a few centimetres for a surveyed
  `IfcMapConversion`; decimetres to metres for an estimated one, and nothing
  in the model says which. The margin assumes 0.5 m (1 sigma) unless the caller
  states the uncertainty. Errors the terrain cannot reveal (up to `entryAbove`,
  2.5 m, relative to the terrain next to the ground-storey doors) remain; see
  [Height reference](#height-reference) for what the allowance covers and what
  it does not. Rotation errors grow with distance from the origin. The
  vertical datum, when the model does not state it, is assumed equal to the
  terrain's.
- **Levels**: doors and windows take the lower of their placement origin and
  the bottom of the filled opening where the opening's body is readable;
  without it, a tool that places windows at the head or centre reads high.

### Options

No option makes an outcome more favourable than the default, except by
supplying information the check cannot get itself. Checked:

| Option | Effect | Allowed |
| --- | --- | --- |
| `edgePolicy` | used to let unreadable samples count as clear | **removed** |
| `ringDistances`, `directions`, `minOutsideDistance` | fewer or other samples can miss a class | **removed**: fixed, recorded in `parameters` |
| `anchorTolerance` | larger: elements away from the outline become favourable | lower only (≤ 1 m) |
| `heightPlausibility.entryAbove` | larger: a model placed too high passes as a raised entrance | lower only (≤ 2.5 m) |
| `heightPlausibility.below/above` | wider: a refusal becomes results | wider allowed, but the height reference is then unconfirmed |
| `clearanceMargin` | smaller: thinner margin | raise only (unchanged) |
| `classResolution` | smaller: thinner margin | raise only (≥ 0.25 m) |
| `georeferenceVerticalUncertainty` | smaller: thinner margin | allowed: it is the caller's statement about the model (default 0.5 m, basis recorded) |
| `renderingConfirmation` (check) | adds information | allowed; without it an empty raster is unconfirmed |
| `otherBuildings` (check), `buildings` (run) | add information | allowed; without a complete source transparent samples are unknown (`other-buildings-unknown`) |
| raster `covers` | the map's coverage perimeter | **required** field of `ClassifiedHazardRaster` (`'everywhere'` stated explicitly); the former `coverage` option is removed, so leaving it out cannot read as covered |
| `cellSize` (run, provider) | coarser cells can drop a thin flow path | ≤ 0.5 m (half the model raster) |
| `terrainResolution` (run) | coarser grid smooths the terrain | ≤ 0.5 m |
| `maxPlanExtent` (run) | larger: a scale error becomes results | larger allowed, but then unconfirmed |
| `aboveGroundScope`, `boundaryTolerance` (extract) | smaller: elements left unlisted | raise only (≥ 3 m, ≥ 1 m) |
| `groundStorey`, `footprint`, `mapScale`, `expectedCrs` (extract) | supply or restrict information | allowed |
| provider `style` (`maxUnexplainedShare`, `maxUnexplainedPixels`, `blendTolerance`) | turns a style-change refusal into results; unexplained pixels stay unreadable and withhold | allowed |
| provider `maxPixels`, `timeoutMs` | can only refuse | allowed |
| provider `fetch`, `baseUrl`, `cache`, `now` | the source of the data, recorded in provenance | allowed |

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
  `FootprintPartial`, `FootprintQuality`,
  `CheckedBuilding`, `BuildingsNotChecked` (each with its count of candidate
  elements), `CountElementsNotChecked`, `CountElementsWalked`,
  `CountElementsSkipped`, `ElementsSkippedByReason` (each reason with its
  count; covered elements only, so the counts sum to `CountElementsSkipped`),
  `CountFootprintSourcesNotRead`, `FootprintSourcesNotRead`, `StoreysSkipped`
  (when a storey has no placement), `OtherBuildingsSource`, `OtherBuildingsComplete`,
  `GroundStoreyBasis`, `GroundStoreyLevel`, `HeightPlausibilityStatus`,
  `HeightPlausibilityBasis`, `TerrainMinNearBuilding`,
  `TerrainMaxNearBuilding`, `HeightPlausibilityBelow/Above`,
  `HeightReferenceStatus`, `HeightReferenceUnconfirmedBecause`,
  `HeightReferenceEntryTolerance`, `HeightReferenceAllowance`,
  `HeightReferenceEntriesChecked`, `ResidualRiskEN/DE`,
  `ClearanceMargin` (absent when not sized), `ClearanceMarginBasis`,
  `GeoreferenceVerticalUncertainty` and its `...Basis`,
  `TerrainVerticalAccuracy`, `RasterCellSize`, `RingDistances`,
  `MinOutsideDistance`, `AnchorTolerance`, `RasterEmpty`,
  `LayerRenderingConfirmed` (a positive confirmation that vouches for the
  raster) / `LayerRenderingCheck` / `LayerRenderingCheckedAt` (when a check
  was made),
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
  `FavourableWithheldBecause`, `ResidualRiskEN/DE`, `Notes`, `Dataset`, `DatasetDate`,
  `RetrievedAt`, `Attribution`, `SitePropertySet`. A payload read on its own
  therefore still carries the caveat, the source and the dataset date.

## Limits

- A building raster that shows a single classified pixel is not "empty", so it
  skips the rendering confirmation; a partly rendered building raster is not
  detected as such.
- A style change that swaps the colours of two known legend classes cannot be
  detected: both still decode.
- The other buildings' footprints are only as good as their source: a
  `complete` flag is the source's statement for its `extent`.
- Without a stated `groundStorey`, every extracted model has an unconfirmed
  height reference, so no element gets `above-mapped-class-range` or
  `no-runoff-mapped`; state the ground storey to get favourable outcomes.
- Samples lie at least 1 m outside the footprint. A hazard strip narrower than
  that, right against the façade (below the map's 1 m cell), is not sampled;
  a footprint up to about 1 m smaller than the building the hazard model
  raised still has samples beyond the raised building.
- Whether a slab hole is open to the sky is read from what lies above it:
  slabs, roofs, roofing coverings, windows lying flat (skylights) and plates,
  each through its body's plain extrusions (an element whose body is a Brep
  or a Boolean solid does not count as roofing). A hatch or skylight not
  modelled as one of these reads as open, so the hole is a courtyard
  (guarded locally; an element there may get `no-ground-sample` when the
  hole is narrower than the sample rings).
- In a given footprint, a ring entirely covered by the others is taken for a
  courtyard (a redundant ring cannot be told from one); in slab outlines it
  never is.
- One eligibility rule for every exclusion (`exclusionDoubt`): an uncertain
  position never supports one, even with a stated `IsExternal = false` (the
  element is kept and the statement noted); an exclusion by distance also
  needs a footprint, and with none inside and outside are unknown (the
  signed distance is `null`, never "infinitely far outside").
- A CRS whose Name and WKT identifier name different EPSG codes is refused
  (`crs-mismatch`, naming both).
- A position read from a clipped body's outer operand is marked uncertain
  (`positionIsUncertain`), as are positions read from part of a body, and a
  level read from it is a lower bound (`levelIsLowerBound`: the cut may have
  removed its bottom), never exact.
- An arc in a profile or curve is traced by points on it alternating with
  tangent corners just outside it: within 5e-5 × the shorter of its radius
  and its length (1 mm on a 20 m radius, 3 cm on a 624 m arc of a 30 km
  radius), and its extent is reached in every direction, in any frame, so a
  bound read from it is never short.
- A slab body extruded obliquely (an `ExtrudedDirection` not along the
  profile's normal) is not read as an outline: the footprint is partial.
- A body read through the first operand of a Boolean DIFFERENCE or clipping
  bounds the level but not the position: an element placed by it is kept.
- A non-boolean `IsExternal` (for example the text `'true'`) reads as
  unstated.
- `OverallHeight` bounds a door or window only between 0.1 m and 10 m after
  unit conversion; outside that range it bounds nothing.
- A representation context whose `WorldCoordinateSystem` is not the identity
  (origin within 1e-6 m after unit scaling, directions within 1e-6) is
  refused (`world-coordinate-system`): placements are read from the world
  origin.
- CRS names are read as `EPSG:<code>`, the OGC URI
  `http(s)://www.opengis.net/def/crs/EPSG/0/<code>`, a WKT `ID`/`AUTHORITY`,
  or a known name.

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
