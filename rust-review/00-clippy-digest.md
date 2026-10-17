# Clippy pedantic+nursery digest (workspace, all targets)

Unique warnings: 30029

## Top messages
```
  14496 long literal lacking separators: help: consider: `_`
   2249 multiply and add expressions can be calculated more efficiently and accurately: help: consider using: `_`
   1989 item in documentation is missing backticks
   1616 casts from `_` to `_` can be expressed infallibly using `_`
   1019 these match arms have identical bodies
    947 casting `_` to `_` may truncate the value
    637 casting `_` to `_` may truncate the value on targets with 64-bit wide pointers
    485 this could be a `_`
    433 pub(crate) function inside private module
    429 redundant closure: help: replace the closure with the method itself: `_`
    407 casting `_` to `_` causes a loss of precision on targets with 64-bit wide pointers (`_` is 64 bits wide, but `_`'s mantissa is only 52 bits wide)
    398 unnecessary structure name repetition: help: use the applicable keyword: `_`
    354 strict comparison of `_` or `_`
    351 unnecessary hashes around raw string literal
    277 `_` appended to existing `_`
    275 variables can be used directly in the `_` string
    229 strict comparison of `_` or `_` arrays
    206 first doc comment paragraph is too long
    156 casting `_` to `_` may lose the sign of the value
    152 adding items after statements is confusing, since items exist from the start of the scope
    143 5 bindings with single-character names in scope
    142 this could be rewritten as `_`: help: consider writing: `_`
    142 called `_` on an `_` value
    128 binding's name is too similar to existing binding
    121 casting `_` to `_` may truncate the value on targets with 32-bit wide pointers
    109 pub(crate) struct inside private module
     99 you seem to be trying to use `_` for destructuring a single pattern. Consider using `_`
     78 casting `_` to `_` causes a loss of precision (`_` is 64 bits wide, but `_`'s mantissa is only 52 bits wide)
     73 strict comparison of `_` or `_`: help: consider comparing them within some margin of error: `_`
     70 manual implementation of `_` which can overflow: help: use `_` instead: `_`
     65 6 bindings with single-character names in scope
     64 redundant clone: help: remove this
     64 hypotenuse can be computed more accurately: help: consider using: `_`
     62 pub(crate) import inside private module
     61 this argument is passed by value, but not consumed in the function body
     59 casting `_` to `_` causes a loss of precision (`_` is 32 or 64 bits wide, but `_`'s mantissa is only 23 bits wide)
     59 calling `_` is more clear than this expression: help: try: `_`
     56 it is more concise to loop over references to containers instead of using explicit iteration methods: help: to write this more concisely, try: `_`
     55 unused `_` argument
     53 this could be rewritten as `_`
```
## Non-test warnings by crate
```
   4689 rust/geometry
   1349 rust/processing
   1106 rust/export
    551 rust/wasm-bindings
    511 apps/server
    319 rust/core
    305 rust/landxml
    146 rust/clash
     25 rust/ffi
     12 rust/cloud-import
```
## Lock/guard temporaries held longer than needed (significant_drop_tightening)
```
apps/server/src/routes/parse/json.rs:172:9: warning: temporary with significant `Drop` can be early dropped
apps/server/src/routes/parse/parquet_stream.rs:93:9: warning: temporary with significant `Drop` can be early dropped
apps/server/src/services/streaming.rs:122:9: warning: temporary with significant `Drop` can be early dropped
rust/geometry/tests/issue_6446_mapped_source_frames.rs:147:9: warning: temporary with significant `Drop` can be early dropped
rust/geometry/tests/nested_mapped_item.rs:257:13: warning: temporary with significant `Drop` can be early dropped
rust/geometry/tests/nested_mapped_item.rs:287:13: warning: temporary with significant `Drop` can be early dropped
rust/processing/src/processor/mod.rs:1404:25: warning: temporary with significant `Drop` can be early dropped
rust/processing/src/processor/mod.rs:1419:25: warning: temporary with significant `Drop` can be early dropped
rust/wasm-bindings/src/api/gpu_meshes/batch.rs:191:21: warning: temporary with significant `Drop` can be early dropped
rust/wasm-bindings/src/api/gpu_meshes/batch.rs:208:21: warning: temporary with significant `Drop` can be early dropped
rust/wasm-bindings/src/api/mod.rs:345:17: warning: temporary with significant `Drop` can be early dropped
rust/wasm-bindings/src/api/mod.rs:353:17: warning: temporary with significant `Drop` can be early dropped
rust/wasm-bindings/src/api/mod.rs:365:17: warning: temporary with significant `Drop` can be early dropped
rust/wasm-bindings/src/api/mod.rs:371:17: warning: temporary with significant `Drop` can be early dropped
rust/wasm-bindings/src/api/mod.rs:383:17: warning: temporary with significant `Drop` can be early dropped
rust/wasm-bindings/src/api/mod.rs:390:17: warning: temporary with significant `Drop` can be early dropped
rust/wasm-bindings/src/api/mod.rs:959:21: warning: temporary with significant `Drop` can be early dropped
```
## Redundant clones (non-test)
```
apps/server/benches/serialization.rs:211
apps/server/benches/serialization.rs:228
apps/server/benches/serialization.rs:241
apps/server/src/routes/parse/parquet_stream.rs:241
apps/server/src/routes/parse/parquet_stream.rs:242
apps/server/src/routes/parse/parquet_stream.rs:339
apps/server/src/routes/parse/parquet_stream.rs:344
apps/server/src/services/data_model/spatial_tree.rs:84
rust/geometry/src/kernel/retriangulate.rs:782
rust/geometry/src/kernel/retriangulate.rs:819
rust/geometry/src/router/caching.rs:207
rust/geometry/src/router/caching.rs:238
rust/geometry/src/router/voids/mod.rs:912
rust/landxml/src/alignment/parser/state.rs:140
rust/processing/src/appearance/evaluated.rs:134
rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:682
rust/wasm-bindings/src/api/landxml/endpoints/methods.rs:84
```
