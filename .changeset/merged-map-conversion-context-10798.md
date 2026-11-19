---
"@ifc-lite/export": patch
---

A merged STEP export keeps a later model's representation context separate when its IfcMapConversion differs from the first model's. It used to unify the two contexts whenever their coordinate frames matched, so one frame carried two georeferences. Models with the same conversion, or where only one is georeferenced, still share one context.
