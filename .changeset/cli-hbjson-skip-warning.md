---
'@ifc-lite/cli': minor
---

`bim.export.hbjson()` (and the `ifc-lite export hbjson` command) now warns on stderr when the export drops `IfcSpace` volumes as degenerate (malformed footprint, holes, non-extrusion), e.g. `HBJSON export: 6 of 40 IfcSpace skipped as degenerate (malformed footprint / holes / non-extrusion); 34 rooms written.` Previously a model with degenerate spaces produced a truncated-but-"successful" HBJSON file with no signal that anything was dropped. The returned string contract is unchanged; a clean export (nothing skipped) emits no extra output.
