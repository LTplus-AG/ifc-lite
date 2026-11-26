---
"@ifc-lite/ids": patch
---

IDS `partOf` now keeps `IfcRelAggregates` and `IfcRelNests` apart when a `relation` is given: a nested element no longer satisfies an `IfcRelAggregates` requirement, and an aggregated element no longer satisfies an `IfcRelNests` one. With no relation, both still count.
