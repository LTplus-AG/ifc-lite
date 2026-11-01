---
"@ifc-lite/viewer": patch
---

With `perf.sceneSnapshot` on, changing a type-visibility setting now costs one ordinary open, which writes a new snapshot. Before, every open adopted the old snapshot and rebuilt it.
