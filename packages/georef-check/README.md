# @ifc-lite/georef-check

Say what is wrong with an IFC model's georeferencing, and how to fix it.

Most real-world georeferencing problems leave the model in the wrong place: thousands of kilometres off, 1000× too big, or turned. This package turns a model's georeferencing facts into a report. The report gives the Levels of Georeferencing (LoGeoRef) the file contains and a list of findings. Each finding has:

- a stable `code` and a `severity` (`error`: a tool that follows IFC places the model wrong; `warning`: likely wrong or ambiguous; `info`: missing information);
- a one-sentence `message` a student can act on;
- the `evidence`: the numbers the finding is based on;
- `fixes`: structured changes (`{ entity, entityId, attribute, value }`, with EXPRESS attribute names) that a write API can apply. `value: null` means only the user knows the answer, for example the EPSG code of a model that has none.

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
| `additionalMapConversions` | every IfcMapConversion when there is more than one |
| `siteLocation` | IfcSite RefLatitude/RefLongitude in decimal degrees, read even when another source wins |
| `hasPostalAddress`, `contextOrigin`, `trueNorth` | LoGeoRef 10 and 40 inputs |
| `coordinates` | where the coordinates actually are (see below) |

Every source is reported, not only the winning one. The parser's `extractGeoreferenceCandidatesOnDemand` keeps the sources that `extractGeoreferencingOnDemand` hides, because the most common defects are disagreements between those sources.

**Coordinate magnitude, without meshing.** `coordinates.siteOrigin` is the first IfcSite's placement origin, composed through `PlacementRelTo` (IfcLocalPlacement only, at most 32 hops). `coordinates.pointMedian` is the per-axis median over an evenly strided sample of at most 2048 IfcCartesianPoint and IfcCartesianPointList2D/3D coordinates. Each point is in its own placement, not composed, and point lists over 2 MB are skipped. The site origin catches map coordinates written into the placements. The median catches geometry authored in map coordinates while the site sits at 0,0. A median rather than a maximum means a few stray far points cannot move it. All values are in project units.

**Injected capabilities**, both optional:

```ts
interface Reprojector {
  // easting/northing in the CRS's own linear unit, easting first whatever the EPSG axis order;
  // return undefined for a CRS you cannot handle, never throw for one
  toGeographic(epsgCode: number, easting: number, northing: number): { latitude: number; longitude: number } | undefined;
}
interface CrsCatalog {
  lookup(code: number): { code: number; kind?: 'projected' | 'geographic' | 'compound' | 'vertical' | 'other';
    areaOfUse?: { west: number; south: number; east: number; north: number }; unitScale?: number } | undefined;
  resolveName?(name: string): number | undefined; // "CH1903+ / LV95" → 2056
}
```

A check that needs a capability the caller did not inject is listed in `report.skipped` with the reason. It is never guessed. Without either capability, UTM zones and the Swiss LV03/LV95 grids still get extent checks, because those extents follow from the CRS definitions.

## Findings catalogue

The course column refers to chapter 2 of *How IFC Works*, "Why the model lands in the wrong place": (1) the map conversion is not read, (2) Scale skipped, 1000×, (3) the map position applied twice, (4) the zone number in front of the Easting, or the old LV03 grid, (5) the turn left out or reversed, plus its IFC2x3 and TrueNorth notes.

| Code | Severity | Fires when | Threshold and why | Course |
|---|---|---|---|---|
| `NO_GEOREFERENCE` | warning | no operation, no CRS, no site latitude/longitude, no map coordinates in placements | none; a warning, because furniture and products may legitimately be local | (1) |
| `SITE_LOCATION_ONLY` | warning | IFC4+ with site latitude/longitude but no operation | IFC itself calls the site point an approximate indication | (1), IFC2x3 note |
| `SITE_LOCATION_DEFAULT` | warning | site within 0.01° of a known authoring-tool default, or within 0.001° of 0°/0° | defaults are written verbatim; 0.01° ≈ 1.1 km. The list (`site-defaults.ts`) only grows with evidence | — |
| `SITE_LOCATION_CONTRADICTS_OPERATION` | warning | the reprojected site origin is more than 10 km from the site latitude/longitude (detects swapped latitude/longitude); without a reprojector, the site is outside the catalogue area of use by more than 0.5° | the site point is approximate and some tools put it at a corner; 10 km is beyond any site. Waits while the map position itself is flagged | TrueNorth / RefLatitude note |
| `MAP_POSITION_APPLIED_TWICE` | error | the anchor is at least 100 km from the origin and the site origin or the geometry median is within 10 km of it; or the site repeats the Eastings/Northings numbers in another unit (within 10% of their magnitude) | the same constants as the viewer's render-time neutraliser (`map-absolute.ts`), so the report and the correction agree. A correct model sits near its local origin, the full anchor distance away | (3) |
| `MAP_COORDINATES_IN_PLACEMENTS` | warning | no operation, and the site origin or geometry median is at least 100 km from the origin (LoGeoRef 30) | 100 km is map magnitude in every projected CRS in use | (3), precision paragraph |
| `SCALE_UNIT_MISMATCH` | error / warning | an authored Scale (× FactorX) differs from `lengthUnit / mapUnit` by a power of ten (within 2%) or a foot ratio (within 1%): error; by an unexplained factor outside [0.5, 2]: warning | grid scale factors stay within 5% of 1 and are never flagged | (2) |
| `SCALE_DOES_NOT_BRIDGE_UNITS` | warning | Scale unset or 1 while the project and map units differ by more than 5% | warning, not error: tools that follow IFC to the letter place it 1000× off, lenient ones (ifc-lite among them) guess right | (2) |
| `SCALE_INVALID` | error | Scale or a factor is zero, negative or not finite | — | (2) |
| `EASTING_ZONE_PREFIX` | error | UTM CRS (EPSG code ranges of plain UTM zones only), the Easting's millions digits equal the zone, and the remainder is a valid easting (100–900 km) | exact pattern; national grids with a UTM-like projection (EPSG:3006) are excluded | (4) |
| `EASTING_ZONE_PREFIX_MISSING` | error | zone-prefixed CRS (EPSG:4647, 5649, 5650) and an Easting of 100–900 km | the inverse of the above | (4) |
| `LV03_LV95_MIX` | error | EPSG:2056 with Eastings/Northings in the LV03 extent, or EPSG:21781 with them in the LV95 extent | national extents with 5 km margin; the two never overlap | (4) |
| `OUTSIDE_CRS_AREA` | error | the model's map position is outside the CRS extent under every map-unit reading: built-in extents for UTM and LV03/LV95, otherwise the catalogue area of use (+0.5°) through the reprojector. Suggests swapped axes or a ×1000 / feet rescale when one lands inside | skipped, not guessed, when no extent is known | (1), (2) |
| `CRS_NOT_RESOLVABLE` | warning / info | the CRS Name is not an EPSG code and no WKT identifier gives one (warning); a catalogue resolves the name (info, with the code as fix) | — | — |
| `OPERATION_WITHOUT_CRS` | error | an IfcMapConversion, ePSet or IfcRigidOperation whose target CRS has neither a name nor a WKT | covers "IfcRigidOperation without a usable CRS" | (1) |
| `MAP_UNIT_MISSING` | warning / info | a projected CRS with no MapUnit: warning when the project unit and the CRS unit differ (readers disagree), info otherwise | — | (2) |
| `VERTICAL_DATUM_MISSING` | info | a projected CRS with no VerticalDatum, unless the catalogue says the CRS is compound | info: common and only matters for heights | Where on Earth |
| `ROTATION_INVALID` | error / warning | XAxisAbscissa and XAxisOrdinate both zero (error), or only one of them set (warning) | — | (5) |
| `ROTATION_NOT_UNIT_LENGTH` | warning | the axis vector's length differs from 1 by more than 0.001 | 1 mm per metre; below that it is rounding | (5) |
| `TRUE_NORTH_CONTRADICTS_ROTATION` | warning / info | the authored TrueNorth differs from grid north by more than 5° (detects a reversed turn); info when TrueNorth is left at the default | 5° is beyond meridian convergence (under about 3° within a UTM zone at building latitudes) | (5), TrueNorth note |
| `ORTHOGONAL_HEIGHT_IMPLAUSIBLE` | warning | \|OrthogonalHeight\| above 10 km under every map-unit reading | no structure is there; usually millimetres | (2) |
| `SOURCES_DISAGREE` | warning | the IFC4 entity and the ePSet, or two IfcMapConversions, differ by more than 1 m, 0.01°, a Scale ratio of 1e-6, or EPSG code | tools pick different winners | IFC2x3 note |
| `IFC2X3_NO_EPSET` | info | IFC2X3 without `ePSet_MapConversion` | the property sets are a buildingSMART convention, not schema | IFC2x3 note |

**When MapUnit is unset**, readers disagree: some use the project length unit, others the CRS's own unit. The diagnosis keeps both readings. A position defect (out of area, implausible height) must hold under both. A match (zone prefix, double application) may hold under either, because coincidence with a 100 km anchor is not chance.

### Considered and left out

- **The turn left out by a viewer**, and **the map conversion not read**: these are tool defects, not file defects. A correct file produces no finding.
- **LV03 and LV95 differ locally by up to 1.6 m**: that difference cannot be seen from one file. The shift fix carries a caveat that points to swisstopo REFRAME.
- **Default site locations of tools other than Revit**: not added without evidence. A wrong entry would flag real projects.
- **A wrong EPSG code for the right numbers** (a German model declared in a Swedish CRS): caught as `OUTSIDE_CRS_AREA` only when an extent is known.

## Fixtures

`fixtures/` holds one small synthetic IFC file per finding, plus clean files that must produce none. Among the clean files is a CC0 control terrain from openBIM-surveyor (see `fixtures/README.md`). `src/fixtures.test.ts` runs every file through the real parser.
