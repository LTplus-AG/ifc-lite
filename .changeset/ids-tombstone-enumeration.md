---
"@ifc-lite/ids": minor
"@ifc-lite/mcp": patch
---

IDS validation of a live, edited model now validates the session's effective model instead of the file as parsed (#5184). `createDataAccessor` takes an optional third `entityVisibility` argument (`EntityVisibilityView`). A `MutablePropertyView` satisfies it structurally, and so does a plain structured-clone snapshot. When it is supplied:

- `getAllEntityIds()` and `getEntitiesByType()` enumerate through the shared `@ifc-lite/data` effective-entity accessor. A deleted entity is no longer counted, validated or reported. An entity created this session is validated under its class, and a retyped entity under its new class. `getEntitiesByType()` is the dominant path, because every specification whose applicability names an entity type resolves through it.
- `getEntityType()` answers the same effective class. A created entity's authored attributes (Name, GlobalId, Description, …) are read from its creation payload, because it has no source bytes.

Omitting the argument leaves the accessor answering for the parsed file, unchanged. Attribute and quantity edits are still not reflected. The MCP `ids_validate` tool now passes its model's mutation view.
