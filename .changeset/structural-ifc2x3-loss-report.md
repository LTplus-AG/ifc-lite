---
"@ifc-lite/export": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

Fix silent structural-analysis data loss on IFC4 → IFC2X3 conversion: `IfcStructuralLoadCase`, `IfcStructuralCurveAction` and `IfcStructuralSurfaceAction` now map to their real IFC2X3 targets (`IfcStructuralLoadGroup`, `IfcStructuralLinearAction`, `IfcStructuralPlanarAction`) instead of becoming generic `IFCPROXY` placeholders. Add `analyzeConversionLoss`/`classifyEntityTypeConversion` (`@ifc-lite/export`), a per-type schema-conversion loss report computed without attempting the export, so a type with no representation at all in the target schema is named — with its express ids and the attributes it cannot carry — instead of surfacing as an uncaught exception from the middle of a full export. `ifc-lite convert` now prints this report and refuses cleanly, before writing any file, when the source contains a type the target schema cannot represent at all. Add the missing `structural_data` MCP tool so an MCP client can read the structural analysis model, matching the CLI/SDK/viewer coverage `bim.structural` already had.
