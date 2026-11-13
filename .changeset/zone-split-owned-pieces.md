---
"@ifc-lite/viewer": patch
---

The zone split worker receives each mesh piece as its own copy, so a piece that views a larger buffer no longer clones that whole buffer.
