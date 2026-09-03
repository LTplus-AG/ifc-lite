---
"@ifc-lite/export": patch
---

Fix `MergedExporter` emitting a duplicate `IfcRelAggregates` membership when a spatially-unified relationship was only partially redundant. When a later model's `Building`/`Site`/`Storey` unifies with the first model's, and its `IfcRelAggregates` lists both a now-unified member and a genuinely new one, the rel was previously kept unmodified — re-listing the unified member a second time (the first model's own relationship already aggregates it), so the same child appeared twice under the same parent. The rel's `RelatedObjects` list is now stripped of the already-covered members, keeping only the new ones.
