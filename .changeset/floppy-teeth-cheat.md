---
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
"@ifc-lite/mcp": minor
"@ifc-lite/cli": patch
"@ifc-lite/viewer": patch
---

Share atomic loaded-model creation for the existing eight ordinary builders across viewer, SDK and the MCP headless backend. Public MCP flows can create the four kinds exposed by existing element-spec nodes: wall, column, beam and slab, with complete recorded undo. Late creation refusals retain all prior records and leave no helper entities. Preserve existing placement and owner-history defaults, and include the IFC2X3 slab PredefinedType attribute in saved records.
