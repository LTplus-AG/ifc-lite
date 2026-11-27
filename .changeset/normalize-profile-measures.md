---
'@ifc-lite/export': patch
---

Normalize mass per length, moment of inertia, section modulus, and warping constant when merging IFC models with different length units. Use the projects' declared derived units and scale IFC2X3 profile lengths and areas alongside their derived measures. Values that carry their own units stay in those units.
