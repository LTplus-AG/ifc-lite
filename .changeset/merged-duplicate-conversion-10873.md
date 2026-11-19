---
"@ifc-lite/export": patch
---

A merged STEP export of models with the same georeference writes one coordinate operation and one projected CRS for their shared context. It used to keep each model's copy, so the context had two operations, which `HasCoordinateOperation SET [0:1]` forbids.
