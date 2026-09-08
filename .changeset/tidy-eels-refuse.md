---
'@ifc-lite/cli': patch
---

`extract-entities` no longer loses spatial containment when a relation owns a
private `IfcOwnerHistory`, and no longer emits a reference to an id the source
file never defines.

The relation planner now reports the unkept references that block a relation
which would otherwise survive, and `buildSubset` keeps them and replans, so an
exporter that writes one `IfcOwnerHistory` per relationship keeps its storey
contents instead of extracting an orphaned storey (#4126). The forward closure
no longer adds an id that is referenced but never defined, which is what stops a
phantom id, such as `#999` read out of a `'C1 see #999'` Name, from surviving
into a rewritten `RelatedElements` set (#4128).
