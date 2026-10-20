---
"@ifc-lite/wasm": patch
---

Keep separated wall patches in their own source planes during CSG consolidation when their projected intervals have a strict gap. This prevents a nearby-normal plane bucket from moving a remote patch away from its neighboring faces (#7633).
