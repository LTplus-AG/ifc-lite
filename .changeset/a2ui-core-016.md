---
"@ifc-lite/a2ui": minor
"@ifc-lite/mcp": minor
---

Align the IFC catalog, viewer renderer and MCP consumer on A2UI web core 0.16.1
and preserve the shared Zod 3 schema dialect under the workspace's Zod 4 version.
The v1.0 catalog now requires `TextField.value` and omits the explicit
`unevaluatedProperties: false` restriction from the eight IFC component schemas.
