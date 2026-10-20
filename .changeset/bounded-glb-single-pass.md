---
"@ifc-lite/wasm": patch
---

Rust only, in `ifc-lite-export`; nothing in the wasm package changes. The bounded single-GLB assembler, which `try_export_glb_with_stats` uses for inputs over the streaming threshold, can mesh a model once instead of twice. `GltfOptions::single_pass_budget_bytes` lets its first pass keep the model's distinct shapes up to that many bytes and write them from memory, falling back to a second meshing pass when they do not fit. The output is byte-identical. The default is 0, so nothing changes until a caller sets a budget.
