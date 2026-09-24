---
"@ifc-lite/data": patch
"@ifc-lite/mutations": patch
---

Adding many elements into a model no longer slows down quadratically (#5413). Every `bim.store.add*` call, Flow `Add element` lane and UI add looked up the owner history and representation contexts by walking every entity created so far, so adding 2,000 columns took about 12 s. The effective-entity enumeration now reads a single-class query from a per-class index of created entities, and checks created-entity membership in O(1). The same 2,000 columns now take about 0.4 s, and 4,000 about the same. `MutablePropertyView` gains `getNewEntitiesOfType(type)`, and `EffectiveEntityOverlay` gains two optional members, `getNewEntity` and `getNewEntitiesOfType`. A plain-data overlay without them keeps the previous full scan.
