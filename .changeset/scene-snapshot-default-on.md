---
"@ifc-lite/viewer": minor
---

Reopening a cached single-file model is now much faster: from the second reopen the complete model appears in about 1 s instead of about 5 s (343 MB model, RTX 4000 Ada), because the viewer stores the finished scene and draws it before the metadata decodes. It adds to each model's cache entry (31 MB on that model), and is skipped when storage is tight. `?perf.sceneSnapshot=0` turns it off.
