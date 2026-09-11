---
"@ifc-lite/viewer": patch
---

Expose the behind-surface limit for scan appearance transfer. The sampling controls gain **Maximum depth behind the IFC surface** (default 5 mm, bounded by the maximum scan distance) and the coverage report names how many samples were refused as behind the surface, so the far side of a thin wall never silently counts as observed or as an incompatible normal.
