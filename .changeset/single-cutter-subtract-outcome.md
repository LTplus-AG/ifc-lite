---
"@ifc-lite/wasm": patch
"@ifc-lite/server-bin": patch
---

A single opening cut now takes "did it cut the host" from the geometry kernel, instead of the void router guessing from the triangle count and a 0.1 % volume change. A small real cut that kept the triangle count, such as a thin mitre at a wall end, was read as no cut and thrown away, and the wall rendered un-cut. A cutter that never reaches the host is handled as before.
