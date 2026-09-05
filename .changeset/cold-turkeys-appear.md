---
"@ifc-lite/parser": patch
"@ifc-lite/wasm": minor
---

Reduce cold IFC loading work with compact native entity indexes and model-scoped BREP signatures. Replace contended schema classification caches, avoid redundant parser scans and sorting, and stop retaining unrelated property sets during georeferencing discovery.

The shared Rust crates add a bounded direct-address entity index and an opaque model-scoped BREP signature cache for batch consumers. Existing supplied hash indexes and the WASM JavaScript API remain compatible.

The minor bump carries the additive Rust API release: the release pipeline derives Rust minor versions from the highest npm workspace package version.
