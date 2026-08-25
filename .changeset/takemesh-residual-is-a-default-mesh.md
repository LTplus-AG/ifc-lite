---
"@ifc-lite/wasm": patch
---

`MeshCollection.takeMesh(i)` now leaves a DEFAULT mesh behind rather than a metadata-bearing husk.

`takeMesh` is read-once by contract and moves the vertex data out. It used to move the buffers field by field and copy the scalars, so a second read of the same index still reported the real `expressId`, `color`, `geometryClass`, `origin`, `localBounds` and `localToWorld` alongside empty buffers. It now moves the whole struct, so a second read reports `expressId 0`, `color [0,0,0,0]`, `geometryClass 0`, `origin [0,0,0]` and no bounds.

This only affects a consumer that calls `takeMesh(i)` and then reads metadata for the same `i` again. That second read is affected whether it goes through `takeMesh` or `get`, because the data is gone from the collection either way. `get` on an index never taken is unaffected. The documented contract was already read-once and the in-repo streaming path takes each index exactly once, so nothing here changes. Read the metadata before taking, or use `get` for every read of that index.

The change comes from collapsing three hand-written 21-field copies of `MeshDataJs` into a derived `Clone`, which is what removes the per-field edit cost that #3199 paid three times over.
