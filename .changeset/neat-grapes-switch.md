---
"@ifc-lite/wasm": minor
"@ifc-lite/diff": patch
---

Add the independent `@ifc-lite/wasm/diff` payload with retained Rust diff models, canonical fingerprint, sidecar and lineage bindings, and validated column/reference transport for the forthcoming diff facade. Existing diff entry points continue to use their current implementation during parity and performance qualification.

Staged raw fingerprint and lineage bindings explicitly reject unpaired UTF-16 surrogates before Rust string conversion; literal replacement characters and valid surrogate pairs remain supported. Fingerprint rejection includes typed names, nested property/quantity values and object keys; ignored record extras remain outside the projection. Full arbitrary UTF-16 support remains required for the separate public facade cutover.
