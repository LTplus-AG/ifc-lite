---
"@ifc-lite/export": patch
---

`MergedExporter` no longer gives an object a second `IfcRelNests` parent. In IFC2X3 output, `IfcRelNests` and `IfcRelAggregates` fill the same `Decomposes : SET [0:1]` inverse, so a later model nesting an object that the primary model already aggregated (or nested) gave it two decomposition parents once the two copies unified. In IFC4 and later, a second `IfcRelNests` parent broke `Nests : SET [0:1]` in the same way. The one-parent pass from #5471 now covers `IfcRelNests` as well, and the output schema decides which relationships share an inverse (#5726).
