---
"@ifc-lite/data": minor
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": minor
---

Central perf-flag registry (#6962). Every runtime perf toggle is declared once in the viewer's `PERF_FLAGS` registry with an owner, a removal condition and its bindings. The existing `__IFC_LITE_*` globals, URL params and sticky keys keep working unchanged; each global-backed flag also accepts a `?perf.<id>=` URL param when the global is unset (for example `?perf.chunks=0`). `@ifc-lite/data` adds the shared `readPerfFlagRaw` reader and `@ifc-lite/geometry` exports `GEOMETRY_PERF_FLAG_BINDINGS`, the bindings of the three flags its host thread reads.
