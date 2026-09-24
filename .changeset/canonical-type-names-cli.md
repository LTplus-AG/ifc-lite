---
"@ifc-lite/cli": patch
"@ifc-lite/export": patch
---

User-facing output uses the canonical IFC EXPRESS class name everywhere, as AGENTS.md requires. STEP stores class names UPPERCASE and `entityIndex.byType` is keyed by that raw spelling, so three surfaces printed `IFCWALLSTANDARDCASE` where `IfcWallStandardCase` belongs:

- `ifc-lite info` mapped `typeCounts` through `IFC_ENTITY_NAMES` but not the drop census, so one report showed the same class both ways — `IfcIndexedPolygonalFace` under "Other types" and `IFCINDEXEDPOLYGONALFACE` under "Skipped classes".
- `ifc-lite gym`'s observation was raw throughout. That is the machine-readable contract an agent consumes, and it disagreed with `info --json` on the same model.
- The export's withheld-entity warning (reached via `ifc-lite anonymize`) named the raw class. The uppercase form is still used for the `IFCREL*` and style-rescue matching it is load-bearing for; only the message changes.
