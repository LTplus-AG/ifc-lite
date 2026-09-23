---
"@ifc-lite/export": patch
---

Fix `filterHiddenRefsFromRelationshipLine` narrowing `IfcTextureMap.Vertices` (and any other `STYLE_RESCUE_TYPES` list) below its own declared lower bound when a session deletion excluded one of its members. `Vertices` is `LIST [3:?]`: dropping one excluded vertex out of three previously produced a 2-vertex list, which is a different invalid STEP file than the dangling reference it replaced, since the schema requires at least three. Narrowing now reads each slot's own declared lower bound from the version-correct schema registry (the same fix `narrowNonRelPositionalRefLists` already applies to non-relationship lines) and leaves the slot exactly as the source wrote it, dangling reference intact, when narrowing would drop it below that bound.
