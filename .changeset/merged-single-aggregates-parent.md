---
"@ifc-lite/export": patch
---

`MergedExporter` no longer gives an object a second `IfcRelAggregates` parent. When a later model's Building (or any object) unified with one the primary model already aggregated under a different parent, for example a Building under a Site in one model and directly under the Project in the other, the later model's relationship was kept and the merged Building failed `IfcSpatialStructureElement.WR41`. A member that already has a parent in the output is now dropped from the later relationship, and the relationship is skipped if nothing is left. This also covers objects unified by GlobalId, and a third model re-parenting an object the second model already parented (#5471).
