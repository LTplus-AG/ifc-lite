---
"@ifc-lite/ids": patch
"@ifc-lite/parser": patch
---

IDS attribute facets can now find `GlobalId` through patterns and enumerations, and check the presence of `OwnerHistory`, `ObjectPlacement`, and `Representation` on parsed and newly created entities. The parser's `extractAllEntityAttributes` accepts `{ includeDisplaySkipped: true }` to include populated attributes that the default display extraction omits. (#10543)
