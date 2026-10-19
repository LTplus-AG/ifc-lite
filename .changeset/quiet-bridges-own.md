---
"@ifc-lite/ifcx": patch
"@ifc-lite/wasm": minor
---

Move composed IFCX mesh and point geometry planning, placement, triangulation and normal evaluation into one source-independent Rust program. Preserve synchronous extraction without initialization through a static JavaScript target generated from the same Rust implementation, and expose the matching imported packet executor in the full WebAssembly build.
