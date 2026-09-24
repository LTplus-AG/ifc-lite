---
"@ifc-lite/mcp": minor
---

`entity_create` accepts an optional `global_id`, the MCP counterpart of the `GlobalId` the in-store builders and `bim.store.add*` take. It is validated as a 22-character IFC GUID, applies to IfcRoot subtypes only (written to attribute 0), and a GlobalId already carried by an entity in the model (parsed or created this session) is refused with `INVALID_INPUT` instead of authoring a duplicate.
