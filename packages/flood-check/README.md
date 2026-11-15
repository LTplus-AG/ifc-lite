# @ifc-lite/flood-check

Headless screening of a georeferenced building model against a surface-runoff
hazard map. **This release is the model-reading half**: from a parsed model it
reads the elements such a check needs (doors, windows, openings, light wells,
external stairs and ramps, and technical equipment in the lowest storeys),
each with its map position, its level and the quality of both, the building
footprint with a quality record that only accumulates, and every element it
skipped with the reason. The hazard-map check itself, the provider for the
Swiss federal *Gefährdungskarte Oberflächenabfluss* (BAFU) and the
property-set payloads follow in the next release; where the text below says
"the check", it describes how that part uses these facts.

Nothing here decides about flooding: these facts are the input, and every
uncertainty is kept on them (an upper-estimate level, an uncertain position,
a partial or hull-like footprint, a guessed ground storey) so the check can
refuse to reassure on it.

## Usage

```ts
import { IfcParser } from '@ifc-lite/parser';
import { extractModelFacts } from '@ifc-lite/flood-check';

declare const bytes: ArrayBuffer;

const store = await new IfcParser().parseColumnar(bytes);
// State the ground storey: a storey picked by the ±0.00 convention is a guess.
const facts = extractModelFacts(store, { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });
for (const c of facts.candidates) console.log(c.name, c.category, c.level, c.levelIsUpperEstimate, c.selectedBecause);
console.log(facts.footprint.source, facts.footprint.quality?.worst, facts.skipped.length, facts.warnings);
```

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
  id, GlobalId or Name). Without it, the storey placed nearest project ±0.00
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
  when a slab profile has voids or its `FootPrint` more than one curve,
  because the inner boundaries are not kept), else its external walls' axes
  chained into one closed ring (`external-wall-outline`, which keeps
  courtyards and notches), else the hull of those axes (`external-wall-hull`),
  else the hull of the candidates (`candidate-hull`, with a warning). A hull
  or a slab outline with filled voids fills courtyards and notches, so on it
  no element gets a reassuring outcome; pass a real outline when the model
  has none. When a ground-storey floor slab has no readable outline (a Brep,
  a Boolean UNION) while others do, the footprint misses its area:
  `footprint.partial` is set, the slab is in `skipped`, a warning says so and
  no element gets a reassuring outcome (`partial-footprint`).
  **Every geometry reader reports what it could not read**
  (`src/model/outline.ts`): bodies, slab outlines and wall axes are read item
  by item, every item, and each read returns the items present and the items
  read; a slab whose body holds two extrusions gives two rings, and one with
  an unreadable item is `partial`. A Boolean DIFFERENCE is read through its
  outer operand and marks a slab outline as voids-filled.
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
  as a hull.
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
  Brep, an `IfcMappedItem`, a Boolean UNION), or is absent where it alone
  defines the level (an opening without a body; a light well without one).
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

## Limits

- In a given footprint, a ring entirely covered by the others is taken for a
  courtyard (a redundant ring cannot be told from one); in slab outlines it
  never is.
- A position read from a clipped body's outer operand is marked uncertain
  (`positionIsUncertain`), as are positions read from part of a body.
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
