---
"@ifc-lite/wasm": patch
"@ifc-lite/geometry": patch
---

Reset derived geometry caches and installed style finishes when a reused IfcAPI starts a new prepass or installs an entity index. Preserve source/index install ordering, staged sharded finalize finishes, diagnostics after cleanup, and persistent settings. The geometry worker re-sends style finishes after every content install, because the reset clears them.
