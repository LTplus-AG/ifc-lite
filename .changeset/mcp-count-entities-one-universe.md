---
'@ifc-lite/mcp': patch
'@ifc-lite/viewer': patch
---

`count_entities` now counts BIM products on every grouping, the same universe `query_entities` returns and the CLI's `query --count` / `query --group-by type` use (#3765). The ungrouped total and `group_by: 'type'` folded `store.entityIndex.byType` instead — every raw STEP record, so `IfcCartesianPoint`, `IfcPolyLoop` and `IfcPropertySingleValue` lines were counted as entities — while `group_by: 'storey'` and `group_by: 'material'` walked `bim.query()`. On `AC20-FZK-Haus.ifc` the same tool answered 44,249 by type and 128 by storey, and 128 is what the CLI and MCP's own `query_entities` report.

**This is a behaviour change to the numbers `count_entities` returns.** An agent that read the ungrouped total as "how big is this file" now gets the product count. The raw STEP record count is unchanged and still available from `model_info` and `model_audit`, which are file-statistics tools (the MCP analogue of `ifc-lite info`) and keep `foldedTypeCounts`. The tool's description now says which universe it counts and points at `model_info` for the other one.

`type` filtering, subtype expansion and the IfcPascalCase group keys are unchanged; the group keys now come from `EntityData.type`, the same field `query_entities` reports. A test asserts the three groupings and the ungrouped total agree with `query_entities` on the same fixture.

The web playground's `count_entities` handler (`apps/viewer/src/components/mcp/playground-dispatcher.ts`) is a second implementation, not a caller of the one above — it re-executes the same tool client-side so the browser chat surface can run MCP tools without a server round-trip. Its `group_by: 'type'` branch had the identical bug (folding `store.entityIndex.byType`) and is fixed the same way, so the playground now agrees with the installed MCP server on the same model (#3785 review).
