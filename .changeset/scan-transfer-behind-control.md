---
"@ifc-lite/viewer": patch
---

Expose the behind-surface limit for scan appearance transfer. The sampling controls gain **Maximum depth behind the IFC surface** (default 10 mm, equal to the default project tolerance and bounded by the maximum scan distance) and the coverage report names how many samples were refused as behind the surface, so a same-facing scan surface beyond a thin wall never silently counts as observed.
