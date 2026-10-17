---
'@ifc-lite/geometry': patch
---

A typed `NO_RENDER_GEOMETRY` export refusal is no longer logged as "Failed to exportUsd/exportGlb": it is the exporter's verdict on its input, like a terrain refusal, and is still reported to the caller and rethrown.
