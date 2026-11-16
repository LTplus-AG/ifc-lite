# @ifc-lite/georef-check

Say what is wrong with an IFC model's georeferencing, and how to fix it.

Most real-world georeferencing problems leave the model in the wrong place: thousands of kilometres off, 1000× too big, or turned. This package turns a model's georeferencing facts into a report. The report gives the Levels of Georeferencing (LoGeoRef) the file contains and a list of findings. Each finding has:

- a stable `code` and a `severity` (`error`: a tool that follows IFC places the model wrong; `warning`: likely wrong or ambiguous; `info`: missing information);
- a one-sentence `message` a student can act on;
- the `evidence`: the numbers the finding is based on;
- `fixes`: structured changes, each saying how it can be applied (see [Fixes](#fixes)).

The governing rule is precision over recall: a false alarm on a correct model is worse than a missed defect. Every detector fires only on a signature a correct model cannot show, and every threshold below is named in the code and pinned by a test on both sides.

```ts
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { collectGeorefFacts, diagnoseGeoreference } from '@ifc-lite/georef-check';

const store = await new IfcParser().parseColumnar(new Uint8Array(readFileSync('model.ifc')).buffer);
const facts = collectGeorefFacts(store);
if (facts) {
  const report = diagnoseGeoreference(facts);
  for (const finding of report.findings) console.log(finding.severity, finding.code, finding.message);
}
```

## Input contract

`diagnoseGeoreference(facts: GeorefFacts, options?: DiagnoseOptions): GeorefReport` is pure: no I/O and no globals.

`GeorefFacts` is plain data, so any reader can produce it. `collectGeorefFacts(store)` reads it from a parsed `IfcDataStore`:

| Field | Meaning |
|---|---|
| `schemaVersion` | `IFC2X3`, `IFC4`, `IFC4X3`, `IFC5` |
| `lengthUnitScale`, `lengthUnitDeclared` | project length unit in metres; whether the file declares it |
| `entities` | IfcMapConversion(Scaled) or IfcRigidOperation, and its target CRS, as authored |
| `ePSet` | the IFC2X3 `ePSet_MapConversion` / `ePSet_ProjectedCRS` convention, read even when the IFC4 entities win |
| `additionalMapConversions` | every IfcMapConversion, each with its own TargetCRS, when there is more than one |
| `siteLocation` | IfcSite RefLatitude/RefLongitude in decimal degrees, read even when another source wins |
| `hasPostalAddress`, `contextOrigin`, `trueNorth`, `rootSpatialPlacements` | LoGeoRef 10, 40 and 30 inputs |
| `coordinates` | where the coordinates actually are (see below) |

Every source is reported, not only the winning one. The parser's `extractGeoreferenceCandidatesOnDemand` keeps the sources that `extractGeoreferencingOnDemand` hides, because the most common defects are disagreements between those sources.

**Coordinate magnitude, without meshing.** `coordinates.siteOrigin` is the first IfcSite's placement origin, composed through `PlacementRelTo` (IfcLocalPlacement only, at most 32 hops), and `coordinates.siteLocationPoint` is the IfcCartesianPoint a fix that moves the site edits. `coordinates.geometry` summarises two coordinate families **separately**: IfcCartesianPoint (up to 2048, evenly strided, leaving out every point that is an axis placement's Location, since those are placement offsets, not geometry) and IfcCartesianPointList2D/3D (up to 64 lists, strided over the file, each read through a bounded 8 KiB prefix, whatever its size). The families are never pooled. A file can hold thousands of small local points beside a few large meshes in map coordinates; pooled, the two populations meet in a meaningless middle. A family is at map magnitude when its own median is, and the model is when either family is. Each point is in its own placement, not composed. All values are in project units. The cost is bounded by the sample, not the model: at most 2048 point records, 64 list prefixes, and one first-reference read per axis placement (from the raw bytes) to know which points are placement Locations.

**Injected capabilities**, both optional:

```ts
interface Reprojector {
  // METRES, easting first, whatever the CRS's unit and EPSG axis order; returns [longitude, latitude].
  // Return undefined for a CRS you cannot handle; a throw is caught and the check reported as skipped.
  toWgs84(epsgCode: number, eastingNorthingMetres: readonly [number, number]): readonly number[] | undefined;
}
interface CrsCatalog {
  lookup(code: number): { code: number; kind?: 'projected' | 'geographic' | 'compound' | 'vertical' | 'other';
    areaOfUse?: { west: number; south: number; east: number; north: number }; unitScale?: number } | undefined;
  resolveName?(name: string): number | undefined; // "CH1903+ / LV95" → 2056
}
```

A check that needs a capability the caller did not inject is listed in `report.skipped` with the reason. It is never guessed. Without either capability, UTM zones and the Swiss LV03/LV95 grids still get extent checks, because those extents follow from the CRS definitions.

**Wiring a real reprojector.** The diagnosis is synchronous; CRS resolution (for example `@ifc-lite/geo`'s `resolveCrs`, whose transformers take projected metres, easting first) is not. `crsRequirements(facts, { crsCatalog })` lists the EPSG codes, with the CRS name and WKT, the diagnosis will reproject from, so a caller resolves them first and hands in a lookup:

```ts
import { crsRequirements, diagnoseGeoreference, type GeorefFacts, type GeorefReport, type Reprojector } from '@ifc-lite/georef-check';

// The shape of @ifc-lite/geo's resolveCrs.
type Transformer = { toWgs84(xy: [number, number]): number[] };
type ResolveCrs = (crs: { epsg?: number; name?: string; wkt?: string }) => Promise<Transformer | null>;

async function diagnoseWithGeo(facts: GeorefFacts, resolveCrs: ResolveCrs): Promise<GeorefReport> {
  const transformers = new Map<number, Transformer>();
  for (const crs of crsRequirements(facts)) {
    const transformer = await resolveCrs(crs);
    if (transformer) transformers.set(crs.epsg, transformer);
  }
  const reprojector: Reprojector = { toWgs84: (epsg, [e, n]) => transformers.get(epsg)?.toWgs84([e, n]) };
  return diagnoseGeoreference(facts, { reprojector });
}
```

## Fixes

A fix is a list of `changes`, each `{ entity, entityId, attribute, value }`: a real instance (`entityId`; absent only for a georeferencing record the fix creates) of a real EXPRESS entity and one of its attributes, checked against the repository's schema tables by a test that walks every fix of every fixture. Moving the site placement edits the site's own Location point: `IfcLocalPlacement.RelativePlacement` → `IfcAxis2Placement3D.Location` → `IfcCartesianPoint.Coordinates`, expressed in the parent frame when the placement has a `PlacementRelTo`. `value: null` means only the user knows the answer, for example the EPSG code of a model that has none.

Each fix also carries `apply`, a machine-readable statement of how it can be applied with the georeferencing write API (`bim.georef`):

| `apply.via` | When | Payload |
|---|---|---|
| `georef.update` | the changes edit the model's effective IfcMapConversion / IfcProjectedCRS (or IFC2X3 ePSets), including adding a conversion beside an existing CRS | `input: { ProjectedCRS?, MapConversion? }` with EXPRESS attribute names; `userSupplied` lists the `null` fields. A CRS rename also lists the old CRS's other fields, which the write API makes the caller restate |
| `georef.set` | the model has no map conversion and no CRS: one grouped write of the whole georeferencing | as above; `userSupplied` names what only the user can supply (the EPSG code, the map position) |
| `georef.site` | the changes are only IfcSite RefLatitude / RefLongitude / RefElevation of one site: one `bim.georef.setSite(input)` | `input: { siteId?, RefLatitude?, RefLongitude?, RefElevation? }` (decimal degrees); `userSupplied` lists the `null` fields as `IfcSite.<attribute>` |
| `manual` | an IfcSite change mixed with other changes, IfcRigidOperation, placements, an IfcGeographicCRS, a record that is not the effective one, a CRS defined by WKT, or a file with several IfcMapConversions (the write API refuses those) | `reason` |

## Levels of Georeferencing

`report.levels` follows the published definition (Clemen & Görne 2019; the [IFCGeoRefChecker documentation](https://github.com/dd-bim/City2BIM/wiki/IFCGeoRefChecker); restated in Jaud & Clemen, ISPRS Annals X-4/W5-2024). The levels are independent; a file can show several.

| Level | Present when |
|---|---|
| 10 | an IfcPostalAddress is referenced by an IfcSite or IfcBuilding |
| 20 | an IfcSite has RefLatitude and RefLongitude |
| 30 | a spatial structure element whose IfcLocalPlacement has an empty PlacementRelTo stores a location (a coordinate other than zero, the checker's test) or a rotation. No distance rule: the level says where a value is stored, not that it is a map coordinate |
| 40 | the 3D model context's WorldCoordinateSystem is off the origin, or TrueNorth is authored other than +y |
| 50 | an IfcMapConversion (or its IFC4X3 subtype IfcMapConversionScaled) onto a declared CRS. Not before IFC4: "no IFC-file previous to IFC4 can fulfill this level" |

`report.indicators` keeps the stricter or neighbouring notions as their own facts, so nothing is lost: `placementAtMapMagnitude` (the site origin is at least 100 km out), `geometryAtMapMagnitude` (a coordinate family is), `ePSetConvention` (the IFC2X3 ePSet workaround is present), `rigidOperation` (an IFC4X3 IfcRigidOperation places the model) and `crsDeclared`.

## Findings catalogue

The course column refers to chapter 2 of *How IFC Works*, "Why the model lands in the wrong place": (1) the map conversion is not read, (2) Scale skipped, 1000×, (3) the map position applied twice, (4) the zone number in front of the Easting, or the old LV03 grid, (5) the turn left out or reversed, plus its IFC2x3 and TrueNorth notes.

| Code | Severity | Fires when | Course |
|---|---|---|---|
| `NO_GEOREFERENCE` | warning | no operation, no CRS, no site latitude/longitude, no map coordinates in placements. A warning, because furniture and products may legitimately be local; the message says so when a postal address is all there is | (1) |
| `CRS_WITHOUT_OPERATION` | warning | a CRS is declared but no operation places the model in it. When the site or geometry is already at map coordinates, the fix is a zero-offset conversion | (1) |
| `SITE_LOCATION_ONLY` | warning | IFC4+ with site latitude/longitude, no operation and no CRS; IFC itself calls the site point an approximate indication | (1), IFC2x3 note |
| `SITE_LOCATION_DEFAULT` | warning | site at a known authoring-tool default, or at 0°/0° | — |
| `SITE_LOCATION_CONTRADICTS_OPERATION` | warning | the site latitude/longitude is far from where the conversion puts the model (detects swapped latitude/longitude); without a reprojector, the site is outside the catalogue area of use. Neither side is assumed true: a map conversion at the CRS's false origin, at 0°/0° or off its area, or a site at a tool default, is named as the suspect, and the fix only goes the plausible way (none when both are suspect). Waits while the map position itself is flagged | TrueNorth / RefLatitude note |
| `MAP_POSITION_APPLIED_TWICE` | error | the site origin or a coordinate family's median already sits at the anchor; or the site repeats the Eastings/Northings numbers in another unit. The message and fixes follow the carrier: a site placement can be moved back, geometry in map coordinates leaves the zero-offset conversion as the file-level fix | (3) |
| `MAP_COORDINATES_IN_PLACEMENTS` | warning | no operation and no CRS, and the site origin or a coordinate family is at map magnitude | (3), precision paragraph |
| `SCALE_UNIT_MISMATCH` | error / warning | an authored Scale (× FactorX) differs from `lengthUnit / mapUnit` by a power of ten or a foot ratio (error), or by an unexplained factor outside the band (warning) | (2) |
| `SCALE_DOES_NOT_BRIDGE_UNITS` | warning | Scale unset or 1 while project and map units differ; tools that follow IFC to the letter place it 1000× off, lenient ones guess right | (2) |
| `SCALE_INVALID` | error | Scale or a factor is zero, negative or not finite; the fix targets the invalid attribute | (2) |
| `EASTING_ZONE_PREFIX` | error | plain UTM CRS, the Easting's millions digits equal the zone, the remainder is a valid easting (100–900 km) | (4) |
| `EASTING_ZONE_PREFIX_MISSING` | error | zone-prefixed CRS (EPSG:4647, 5649, 5650) and an Easting of 100–900 km | (4) |
| `LV03_LV95_MIX` | error | EPSG:2056 with LV03 numbers, or EPSG:21781 with LV95 numbers (national extents + 5 km; they never overlap) | (4) |
| `OUTSIDE_CRS_AREA` | error | the model's map position is outside the CRS extent under every map-unit reading and every candidate position (site origin, else each far coordinate family, else the local origin). Suggests swapped axes or a ×1000 / feet rescale when one lands inside. Skipped, not guessed, when no extent is known | (1), (2) |
| `CRS_NOT_RESOLVABLE` | warning / info | the CRS Name is not an EPSG code and no WKT identifier gives one (warning); a catalogue resolves the name (info) | — |
| `OPERATION_WITHOUT_CRS` | error | an operation whose target CRS has neither a name nor a WKT | (1) |
| `MAP_UNIT_MISSING` | warning / info | a projected CRS with no MapUnit: warning when the project unit and the CRS unit differ (readers disagree), info otherwise | (2) |
| `VERTICAL_DATUM_MISSING` | info | a projected CRS with no VerticalDatum, unless the catalogue says the CRS is compound. Suggests a height system only for single-country CRSs (Swiss grids, German zE-N zones, Dutch RD); otherwise none | Where on Earth |
| `ROTATION_INVALID` | error / warning | XAxisAbscissa and XAxisOrdinate both zero (error), or only one set and the default for the other (abscissa 1, ordinate 0) does not give a unit vector (warning) | (5) |
| `ROTATION_NOT_UNIT_LENGTH` | warning | the axis vector's length is off 1 | (5) |
| `TRUE_NORTH_CONTRADICTS_ROTATION` | warning / info | the authored TrueNorth differs from grid north (detects a reversed turn); info when TrueNorth is left at the default | (5), TrueNorth note |
| `ORTHOGONAL_HEIGHT_IMPLAUSIBLE` | warning | \|OrthogonalHeight\| implausible under every map-unit reading; usually millimetres | (2) |
| `SOURCES_DISAGREE` | warning | the IFC4 entity and the ePSet, or two IfcMapConversions (each in its own TargetCRS), differ in offset, turn, Scale or EPSG code | IFC2x3 note |
| `IFC2X3_NO_EPSET` | info | IFC2X3 without `ePSet_MapConversion` | IFC2x3 note |

**When MapUnit is unset**, readers disagree: some use the project length unit, others the CRS's own unit. The diagnosis keeps both readings. A position defect (out of area, implausible height) must hold under both. A match (zone prefix, double application) may hold under either, because coincidence with a 100 km anchor is not chance.

### Thresholds

| Constant | Value | Rationale |
|---|---|---|
| `MAP_MAGNITUDE_METRES` | 100 km | map magnitude in every projected CRS in use; the viewer's `MAP_ABSOLUTE_MIN_ANCHOR_METERS`, so the report and the viewer agree |
| `UNDECLARED_UNIT_SMALLEST_READING` | 0.001 | a file with no length unit is read in metres, but such fragments are as often millimetres; a "map coordinates in the placements" claim on one must also hold read as millimetres |
| `DOUBLE_GEOREF_RADIUS_METRES` | 10 km | a site or coordinate family this close to a ≥100 km anchor already carries it; the viewer's `NORMAL_COORD_THRESHOLD_M` |
| `UNIT_MISMATCH_RELATIVE_RADIUS` | 10% of the anchor | the #9480 signature: the site repeats the anchor numbers in another unit |
| `UNIT_MISMATCH_MIN_UNIT_RATIO` | 2 (either way) | that signature needs project and map units apart; every real pair (mm/m 1000, cm/m 100, ft/m 3.28) is far above 2, and below it the plain-anchor radius already decides |
| `SITE_CONTRADICTION_KM` | 10 km | the site point is approximate and some tools put it at a corner; 10 km is beyond any site |
| `FALSE_ORIGIN_RADIUS_METRES` | 1 km | a map position this close to E 0 / N 0 is the CRS's false origin, a value left when no position was entered; no projected CRS has its own area there |
| `AREA_OF_USE_MARGIN_DEGREES` | 0.5° | EPSG areas follow borders and coasts; a border site, or a project just across that keeps the national grid, must not be called outside. 35–55 km, far below every slip it catches (hundreds of km or more). One constant for both the site check and the map-position check |
| `SITE_DEFAULT_TOLERANCE_DEGREES` | 0.01° | defaults are written verbatim; 0.01° ≈ 1.1 km |
| `NULL_ISLAND_TOLERANCE_DEGREES` | 0.001° | 0/0 written with rounding noise |
| `SCALE_GRID_FACTOR_BAND` | ±5% | grid scale factors (UTM 0.9996, combined factors) stay within it and are never a unit slip |
| `POWER_OF_TEN_TOLERANCE` / `FOOT_TOLERANCE` | 2% / 1% | a ratio this close to 10ⁿ or 0.3048 is a unit slip |
| `UNEXPLAINED_SCALE_BAND` | [0.5, 2] | an off-1 ratio no unit explains is reported only outside it: inside, it may be a deliberate local scale; outside, the model is at least twice or half its size, which no grid or project factor produces |
| `SOURCE_OFFSET_TOLERANCE_METRES` / `SOURCE_ROTATION_TOLERANCE_DEGREES` | 1 m / 0.01° | offsets and turns further apart are different positions, not rounding |
| `SOURCE_SCALE_RELATIVE_TOLERANCE` | 1e-6 | 1 mm per km: below survey tolerance, so float formatting never trips it, while a grid factor or unit is far above |
| `UNIT_LENGTH_TOLERANCE` | 0.001 | 1 mm per metre; below that a non-unit axis vector is rounding |
| `TRUE_NORTH_TOLERANCE_DEGREES` | 5° | beyond meridian convergence (under about 3° within a UTM zone at building latitudes) |
| `MAX_PLAUSIBLE_HEIGHT_METRES` | 10 km | above every mountain and below no realistic structure |
| `MAX_SAMPLED_POINT_LISTS` / `POINT_LIST_PREFIX_BYTES` | 64 / 8 KiB | bounds the probe at about 512 KiB of text however large the meshes; 8 KiB holds about 200 tuples, plenty to tell map magnitude from local |
| `DEFAULT_MAX_SAMPLED_POINTS` | 2048 per family | an even stride over the file; a median over this many is stable |

### Considered and left out

- **The turn left out by a viewer**, and **the map conversion not read**: these are tool defects, not file defects. A correct file produces no finding.
- **LV03 and LV95 differ locally by up to 1.6 m**: that difference cannot be seen from one file. The shift fix carries a caveat that points to swisstopo REFRAME.
- **Default site locations of tools other than Revit**: not added without evidence. A wrong entry would flag real projects. The list in `site-defaults.ts` names its evidence per entry.
- **A wrong EPSG code for the right numbers** (a German model declared in a Swedish CRS): caught as `OUTSIDE_CRS_AREA` only when an extent is known.
- **A FactorY of exactly 0**: the parser reads a zero factor as unset, so it never reaches the facts; a negative or non-finite factor does.

## Fixtures

`fixtures/` holds one small synthetic IFC file per finding, plus clean files that must produce none. Among the clean files is a CC0 control terrain from openBIM-surveyor (see `fixtures/README.md`). `src/fixtures.test.ts` runs every file through the real parser.
