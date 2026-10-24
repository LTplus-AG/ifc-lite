---
"@ifc-lite/wasm": patch
---

Rust only, in `ifc-lite-export`. A patch on an opening or projection no longer keeps it in the output once the plan deletes its host. IFC ties each to exactly one element, so a hostless one was invalid, and a door filling it still pointed at it. It now goes with its host, the fill goes with it, and the patch is refused with the reason ("opening or projection has no host relationship left after this plan's deletes"). An Add that names it still keeps it.
