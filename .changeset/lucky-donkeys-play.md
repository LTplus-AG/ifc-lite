---
'@ifc-lite/cli': patch
---

`extract-entities`: keep spatial containment when extracting a strict subset.

A real exporter writes ONE `IfcRelContainedInSpatialStructure` per storey listing
every product in it, so the previous keep-the-relation-only-when-every-member-is-kept
rule dropped containment on every `--product` / `--type` extraction from a real
model: the extracted products landed outside the spatial tree and a viewer showed
the storey with nothing under it. The relation's `RelatedElements` set is now
rewritten down to the kept members instead, and `IfcRelReferencedInSpatialStructure`
joins `IfcRelAggregates` and `IfcRelContainedInSpatialStructure` in the same
handling. Relations still emit no dangling reference: the relating spatial parent
and every non-set reference must be kept, and an empty intersection drops the
relation. A relation that loses no member emits byte-identical to its source line.
