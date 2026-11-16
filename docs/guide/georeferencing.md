# Georeferencing

A georeferenced IFC model says where on Earth it is. In IFC4 and IFC4X3 that is an `IfcMapConversion` (where the project origin lies on the map, how the model is turned and scaled) onto an `IfcProjectedCRS` (which map: an EPSG code and its unit). IFC2X3 has neither entity; the buildingSMART convention puts the same values in two property sets, `ePSet_MapConversion` and `ePSet_ProjectedCRS`, on the IfcProject. Every model also has an approximate site point, IfcSite `RefLatitude` / `RefLongitude` / `RefElevation`.

ifc-lite reads, writes, checks and fixes all of these, from the CLI, the MCP server and the SDK.

| Task | CLI | MCP tool | SDK |
|---|---|---|---|
| Read | `ifc-lite georef show` | `georeferencing` | `bim.georef.get()` |
| Write | `ifc-lite georef set` / `update` / `remove` | `georeferencing_write` | `bim.georef.set()` / `update()` / `remove()` / `setSite()` |
| Check | `ifc-lite georef check` | `georeferencing_check` | `bim.georef.check()` |
| Fix | `ifc-lite georef fix` (= `check --fix`) | `georeferencing_fix` | `bim.georef.planFixes()` + `fix()` |

## Show

```bash
ifc-lite georef show model.ifc          # CRS, map conversion, rotation, site point
ifc-lite georef show model.ifc --json   # the bim.georef shape (EXPRESS attribute names)
```

## Set

```bash
ifc-lite georef set model.ifc --out geo.ifc --epsg 2056 --map-unit METRE \
  --eastings 2600000 --northings 1200000 --height 400 --rotation 12.5
ifc-lite georef update geo.ifc --out geo2.ifc --height 401
```

Writes fail closed: no CRS, map unit, scale or factor is ever guessed, an existing georeferencing is replaced only with `--replace`, and the written bytes are read back before the file is saved. The write API retains its IFC2X3 host behavior: new sets use IfcSite and updates preserve their host. Property-set host migration is outside the doctor. The [CLI guide](cli.md) lists every option.

## Check

```bash
ifc-lite georef check model.ifc
ifc-lite georef check model.ifc --json --fail-on warning
```

The check reports the Level of Georeferencing found (LoGeoRef 10 to 50), every finding with a stable code, a severity and a plain-language message, and for each finding the fixes it suggests. The exit code is 1 when a finding at or above `--fail-on` exists (`error` by default; `warning`, `info` or `none`).

The check runs offline. It uses the bundled EPSG catalogue (area of use, native unit) and the `@ifc-lite/geo` CRS engine. A CRS outside the bundled index, and the datum-shift grids some CRSs need for an exact datum shift, are only fetched with `--allow-network` (epsg.io and cdn.proj.org). Checks that could not run without them are listed under "Not checked", with what would enable them.

## Fix

```bash
ifc-lite georef fix model.ifc --out fixed.ifc
ifc-lite georef fix model.ifc --out fixed.ifc --dry-run          # show the plan only
ifc-lite georef fix model.ifc --out fixed.ifc \
  --value ProjectedCRS.Name=EPSG:2056 --value MapConversion.Eastings=2600000
ifc-lite georef fix model.ifc --out fixed.ifc --apply EASTING_ZONE_PREFIX.2
```

Every suggested fix gets an id (`<CODE>.<n>`) and a status:

| Status | Meaning |
|---|---|
| will apply (`ready`) | It goes through the georeferencing write API and every value is known. `fix` applies it. |
| needs a value (`needs-value`) | Only you know a value it needs. The output names the `--value PATH=VALUE` to pass, with the current value when there is one. |
| review | The checker marks the fix uncertain (it carries a caveat), or a derived site position fails the plausibility rules below. Never applied; the output shows the command to apply it yourself if you decide to. |
| manual | The write API cannot carry it (placements, IfcRigidOperation). Do it in the authoring tool. |
| alternative | Another fix for the same finding. Each finding's first fix is applied unless `--apply <id>` chooses another. |
| conflict | It would set a field another chosen fix sets differently. Run `fix` again after the first pass. |

`fix` prints exactly which fields change from what to what, writes `--out` (never the input file), reads it back, and checks the written file again to show what remains. When nothing can be applied, no file is written.

### Site position

IfcSite `RefLatitude` / `RefLongitude` are written as `IfcCompoundPlaneAngleMeasure` (degrees, minutes, seconds, millionths of a second; every component negative south or west of the origin). `fix` derives them from the map conversion, through the CRS engine, only when the map conversion is plausible: no error-level finding, the map position checked inside the CRS's area of use, not at the false origin or at 0°/0°, and an unambiguous map unit. When the CRS reaches WGS84 only through a Helmert approximation (no datum grid loaded; a few metres off) or without any datum shift, `fix` derives nothing unless you pass `--accept-approximate-datum` or `--allow-network` loads the grid. `RefElevation` is derived only when the CRS states its vertical datum. Otherwise you supply the values: `--value IfcSite.RefLatitude=46.948 --value IfcSite.RefLongitude=7.447`.

### MCP and SDK

`georeferencing_check` returns the report and the plan as JSON; `georeferencing_fix` takes the same `apply`, `values` and `accept_approximate_datum` inputs, applies the ready fixes in the session (saved by `export_ifc` / `model_save`) and returns the check after them. In a script:

```typescript
import { readFile, writeFile } from 'node:fs/promises';
import { openModel } from '@ifc-lite/sdk/headless';

const model = await openModel(await readFile('model.ifc'));
try {
  const report = await model.bim.georef.check();
  const plan = model.bim.georef.planFixes(report, { values: { 'ProjectedCRS.MapUnit': 'METRE' } });
  for (const fix of plan.fixes) console.log(fix.id, fix.status, fix.reason);
  const result = model.bim.georef.fix(plan); // only the `ready` fixes
  if (result.applied.length > 0) await writeFile('fixed.ifc', model.bim.export.ifc());
} finally {
  model.close();
}
```

A check of a session with unsaved edits checks the model as it would be saved.

## Finding codes

What each finding means and what to do. Codes are stable; `--json` carries them with their evidence.

| Code | Severity | What to do |
|---|---|---|
| `NO_GEOREFERENCE` | warning | Nothing says where the model is. Fine for a product or a furniture model; otherwise `georef set` the EPSG code and the map position of the project origin. |
| `CRS_WITHOUT_OPERATION` | warning | A CRS is declared but nothing places the model in it. Supply the map position of the project origin (`--value MapConversion.Eastings=…` etc.); when the geometry is already in map coordinates the fix is a zero-offset conversion. |
| `SITE_LOCATION_ONLY` | warning | Only the approximate IfcSite point. Add a map conversion (`georef set`). |
| `SITE_LOCATION_DEFAULT` | warning | The site point is an authoring-tool default (Revit's Boston location) or 0°/0°. Set the real location in the authoring tool, or let `fix` derive it from a plausible map conversion. |
| `SITE_LOCATION_CONTRADICTS_OPERATION` | warning | The site point and the map conversion disagree. The message names the suspect side; the fix only goes the plausible way. |
| `MAP_POSITION_APPLIED_TWICE` | error | The placements (or the geometry) already sit at the map position the conversion adds again, so tools that apply the conversion put the model hundreds of kilometres off. Move the site back to the local origin in the authoring tool, or zero the conversion's offsets (shown as a command; the checker marks it for review, because large coordinates in placements jitter in single-precision viewers). |
| `MAP_COORDINATES_IN_PLACEMENTS` | warning | Map coordinates in the placements and no CRS. Declare the CRS with a zero-offset conversion, or better, move them into a conversion in the authoring tool. |
| `SCALE_UNIT_MISMATCH` | error / warning | Scale does not convert the project unit into the map unit (a power of ten or a foot ratio). `fix` sets it. |
| `SCALE_DOES_NOT_BRIDGE_UNITS` | warning | Scale unset while project and map units differ. `fix` sets it. |
| `SCALE_INVALID` | error | Scale or a factor is zero, negative or not a number. `fix` sets it. |
| `EASTING_ZONE_PREFIX` | error | The UTM zone number is written in front of the Easting. `fix` strips it; `--apply EASTING_ZONE_PREFIX.2` declares the zone-prefixed CRS instead. |
| `EASTING_ZONE_PREFIX_MISSING` | error | A zone-prefixed CRS (EPSG:4647, 5649, 5650) without the prefix. Declare the plain UTM CRS, or add the prefix. |
| `LV03_LV95_MIX` | error | LV95 declared with LV03 numbers (or the reverse). `fix` declares the grid the numbers are in once you restate the CRS fields that belonged to the other grid; shifting the numbers instead is for review (the grids also differ locally by up to 1.6 m). |
| `OUTSIDE_CRS_AREA` | error | The map position is outside where the EPSG code is used. Check the code, the unit and the order of Eastings and Northings; `fix` offers a swap or a rescale when one lands inside. |
| `CRS_NOT_RESOLVABLE` | warning / info | The CRS Name is not an EPSG code. Write it as `EPSG:<code>`. |
| `OPERATION_WITHOUT_CRS` | error | A map conversion onto a CRS with no name. Supply `ProjectedCRS.Name`. |
| `MAP_UNIT_MISSING` | warning / info | No MapUnit; readers disagree on the unit. `fix` sets it when the CRS unit is known. |
| `VERTICAL_DATUM_MISSING` | info | No height system. Supply `ProjectedCRS.VerticalDatum` (an EPSG vertical CRS code). |
| `ROTATION_INVALID` / `ROTATION_NOT_UNIT_LENGTH` | error / warning | The turn vector is zero, half set or not unit length. `fix` normalises it. |
| `TRUE_NORTH_CONTRADICTS_ROTATION` | warning / info | TrueNorth and the conversion's turn disagree (often a reversed turn). Check which is right in the authoring tool. |
| `ORTHOGONAL_HEIGHT_IMPLAUSIBLE` | warning | A height that is not a real place, usually millimetres. `fix` writes it in the map unit. |
| `SOURCES_DISAGREE` | warning | The IFC4 entities and the ePSets, or two map conversions, say different things. Remove the stale one (`georef set --replace`). |
| `IFC2X3_NO_EPSET` | info | An IFC2X3 model without the property-set convention. Add it with `georef set`. |

The checker's own catalogue, with every threshold and its rationale, is in the [`@ifc-lite/georef-check` README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/georef-check#findings-catalogue).

The doctor rechecks derived site values in a second pass when another selected fix changes the map conversion. An unreadable site placement is unknown, so it cannot supply a derived position. Hand-built doctor plans support nested `ProjectedCRS` / `MapConversion` fields; use `bim.georef.set` or `update` directly for `replace` and `rotationDegrees`.
