---
"@ifc-lite/wasm": patch
---

An element whose openings together cover it now renders nothing. When those openings could not be merged into one cutter, the cut came back empty but the element was then drawn uncut. In `ifc-lite-geometry`, a cut that empties a host with triangles now marks the host consumed, whichever cut path produced it.
