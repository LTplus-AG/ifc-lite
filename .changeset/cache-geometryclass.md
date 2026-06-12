---
"@ifc-lite/cache": patch
---

Persist `geometryClass` in the binary geometry section so the viewer's Model/Types view switch survives a cache hit. The format previously serialized everything except the per-mesh provenance tag, so restored meshes all came back as class 0 — instanced type-library geometry reappeared in Model mode and the Model/Types switch disappeared. Bumps `FORMAT_VERSION` 4 → 5 (older caches read back as class 0; consumers should key their cache entries on `FORMAT_VERSION` so a bump invalidates stale entries and re-meshes fresh).
