---
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
"@ifc-lite/georef-check": minor
---

The georeferencing doctor: check and fix a model's georeferencing from the CLI, MCP and SDK.

- SDK: `bim.georef.check({ allowNetwork? })` diagnoses with `@ifc-lite/georef-check`, using `@ifc-lite/data`'s EPSG catalogue and `@ifc-lite/geo` transformers resolved for the CRSs the diagnosis needs (names through `@ifc-lite/geo` first, then the catalogue). Offline by default; checks a missing capability prevented are listed in `skipped` with what would enable them. `bim.georef.planFixes(report, { choose?, values?, acceptApproximateDatum? })` gives every suggested fix a status (`ready`, `needs-value`, `review`, `manual`, `alternative`, `conflict`); `bim.georef.fix(plan)` applies only the `ready` ones, never a fix the checker marks uncertain. `bim.georef.setSite({ RefLatitude, RefLongitude, RefElevation })` writes IfcSite's position (IfcCompoundPlaneAngleMeasure to the millionth of a second), as one undo step; the doctor derives it from the map conversion only when that is plausible and the datum shift is not an approximation the user has not accepted.
- IFC2X3: `set`/`update` now write `ePSet_MapConversion` / `ePSet_ProjectedCRS` on the IfcProject, where the buildingSMART "User Guide for Geo-referencing in IFC" (v2.0, §5.1) and IfcOpenShell put them, instead of the IfcSite. Sets found on IfcSite are still read, `remove` deletes them, and `update` moves them to the IfcProject. A model without exactly one IfcProject is refused (was: IfcSite).
- CLI: `ifc-lite georef check <file>` (human or `--json`; exit 1 on findings at or above `--fail-on`, default `error`; `--allow-network`) and `ifc-lite georef fix <file> --out F` (= `check --fix`; `--apply ID`, `--value PATH=V`, `--dry-run`, `--accept-approximate-datum`), which shows each change, writes a new file, verifies it reads back and checks it again.
- MCP: `georeferencing_check` (report and plan as JSON) and `georeferencing_fix`; `georeferencing_write` gains action `site`.
- georef-check: site latitude/longitude fixes are `apply.via: 'georef.site'`; new `EPSET_NOT_ON_PROJECT` warning and `facts.ePSetHosts`.
