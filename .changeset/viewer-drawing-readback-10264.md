---
"@ifc-lite/viewer": patch
---

The Drawing panel and the 3D section overlay now cut GPU-instanced occurrences too; before, they left them out. Geometry whose CPU arrays were released (test-only today, #10264) is read back from the local backing one chunk at a time. A missing, incomplete or replaced backing fails the drawing instead of drawing part of the model.
