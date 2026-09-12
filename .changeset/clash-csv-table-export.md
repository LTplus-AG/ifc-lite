---
"@ifc-lite/clash": minor
"@ifc-lite/export": minor
"@ifc-lite/cli": minor
"@ifc-lite/viewer": minor
---

Export a clash run as a flat CSV table (#3944). `@ifc-lite/clash` gains `clashTableRows` / `CLASH_TABLE_COLUMNS` / `bareIfcGuid`: one row per clash carrying both elements' bare IfcGUIDs (plus the adapter's durable keys), IFC types, names, models, storeys, the contact point, the signed distance and the coordinator's review status, so the table joins back to the model in Excel or Power BI. `@ifc-lite/export` gains `tableToCsv`, the one RFC 4180 writer for row-object tables (every cell through the shared formula-injection escaper; the zone-quantity CSV now uses it). The viewer's clash panel gets a **CSV** button next to the BCF export, and `ifc-lite clash` gets `--csv <out.csv>` (uncapped, unlike the `--json` display limit).
