---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Single-controller threaded-WASM foundation: build the threaded bundle
(`pkg-threaded`) by default and add runtime selection in the geometry loader.
When the host is cross-origin isolated + threads-capable and the page opts in
with `?geomThreads=1`, the orchestrator spawns ONE geometry worker that loads
`@ifc-lite/wasm/threaded` and runs a wasm-bindgen-rayon pool, instead of N
single-thread workers (so it never oversubscribes). Safari / non-isolated hosts
and any threaded-init failure fall back to the single-thread bundle. Opt-in and
off by default while it's validated; flipping the default is a follow-up.
