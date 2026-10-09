---
"@ifc-lite/sdk": minor
---

New `bim.ids.authoring` namespace: `open(xml)` and `create(title)` return an `IDSAuthoringDocument` with `apply(ops)`, `undo()`, `redo()`, `lint()`, `pathOf(nodeId)` and `write()`. Edits go through the same typed operations and grounding gate as the IDS editor and the MCP `ids_apply_ops` tool. A batch that names an entity, property set or property the IFC schema does not have is refused as a whole, and `errors` lists each problem with ranked candidates. `write()` throws rather than return XML that would lose content.
