---
"@ifc-lite/ids": patch
"@ifc-lite/rules": patch
---

A partOf facet without a `relation` now follows every part-of relation, recursively, as IDS 1.0 specifies (#7401). The parser used to read a missing relation as IfcRelContainedInSpatialStructure, so a mullion aggregated into a curtain wall failed `partOf IFCCURTAINWALL`, and the audit reported the IDS manual's own example as `E_IFC_PARTOF_ENTITY`. The parsed facet now carries `anyRelation: true`; validation walks aggregation, grouping, containment, nesting and voids/fills (a chain may mix them), the audit accepts an entity or applicability that any of them allows, and `writeIdsXml` writes such a facet back without a relation. An explicit relation behaves as before. An empty or unrecognised `relation` is not read as "any": the audit flags it (`E_IFC_PARTOF_RELATION`), and `writeIdsXml` now writes it back as read instead of replacing it with the normalised relation.
