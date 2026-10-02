---
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
"@ifc-lite/mcp": minor
"@ifc-lite/cli": patch
"@ifc-lite/viewer": patch
---

Share atomic loaded-model creation for the existing eight ordinary builders across viewer, SDK and MCP. MCP flows can create these ordinary elements and undo them as one recorded edit; late creation refusals retain all prior records and leave no helper entities. Preserve existing placement and owner-history defaults, and include the IFC2X3 slab PredefinedType attribute in saved records.
