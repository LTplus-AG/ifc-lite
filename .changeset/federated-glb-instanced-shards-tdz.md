---
'@ifc-lite/viewer': patch
---

Fix a federated GLB/IFCX/point-cloud add being marked `loadState: 'error'` after it had already loaded successfully.

`useIfcLoader`'s shared `finalizeModel` closure read a `const allInstancedShards`
that is declared ~800 lines further down the same `loadFile` function, inside
the WASM-streaming section. GLB, IFCX, and point-cloud federated adds call
`finalizeModel` before that section ever runs, so the read landed in the
binding's temporal dead zone and threw `ReferenceError: Cannot access
'allInstancedShards' before initialization` — *after* `addModel` had already
registered the model with its correctly parsed geometry. The surrounding
catch then wrote `loadState: 'error'` onto the now-live model, so a user
federating one of these formats saw a failed model that had, in fact, loaded.

`finalizeModel` now takes the GPU-instancing shard bytes as an explicit
parameter (default `[]`), forwarded by the WASM streaming path once it has
populated them. GLB/IFCX/point-cloud loads have no instancing concept, so an
empty array is the correct value on their path, not a placeholder.
