---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-processing`; nothing in the wasm package changes. `data_model::render::flat::resolve_pset_defs` is deprecated. Use `data_model::rows::stream_export_model`, whose rows carry resolved property and quantity sets.
