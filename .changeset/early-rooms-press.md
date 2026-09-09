---
"@ifc-lite/renderer": minor
"@ifc-lite/pointcloud": minor
---

Support absolute model and pointcloud translations without rewriting mesh or scan vertices. Keep model draw origins independent, compose scan alignment and manual offsets in double precision, and retain placement bounds after CPU geometry release. Streaming pointcloud callers can choose a nearby decode origin before narrowing coordinates to float32.
