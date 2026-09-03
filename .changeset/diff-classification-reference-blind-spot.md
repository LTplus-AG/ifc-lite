---
'@ifc-lite/diff': minor
'@ifc-lite/cli': patch
'@ifc-lite/mcp': patch
---

A model comparison did not carry an entity's classification (`IfcRelAssociatesClassification` -> `IfcClassificationReference`) in any channel at all: re-coding an element from one Uniclass group to another, with geometry and every property untouched, read as `unchanged` on `ifc-lite diff --by-content`, the MCP `model_diff` tool, and the viewer's compare panel alike — the same silent-drop shape #1198 fixed for quantity sets. `@ifc-lite/diff`'s `DataFingerprintInput` gains an optional `classifications` field (resolved reference labels, never entity references — an id is reassigned on every save), hashed the same way as the existing `materials` field: present only when the entity carries one, so an unclassified entity's fingerprint is unaffected, and exposed as its own `classification` component key for the content-matching collision guard. All three adapters now populate it.
