---
'@ifc-lite/wasm': patch
---

Return errors instead of trapping the wasm instance on bad input (#7677). The release build aborts on a Rust panic, so each of these used to kill the whole instance:

- `exportMerged` with malformed `lengths` still throws, but the `IfcAPI` handle can now be reused and freed afterwards.
- A progress callback that calls `setGeometryProgressCallback` from inside itself no longer traps.
- `splitMeshByZones` returns `undefined` (no split) for a zone with an `Infinity` or `NaN` parameter, or a vertex or zone corner past ±2^128, the exact kernel's coordinate bound. Past that bound it used to trap or return wrong volumes.
- `planAppearance` with an evaluated occurrence whose shared Body has `*` as its context excludes that product.
- A LandXML stream session closes after its first parse error, so later chunks return an error.
- A near-zero-length LandXML irregular line returns an error.

Rust crates, same release: the exact boolean kernel (`ifc_lite_geometry::kernel::arrangement`) refuses operands with a coordinate past `MAX_OPERAND_COORD` (2^128, above `f32::MAX`, so no `Mesh` operand is affected): empty result and non-conforming instead of a wrong solid. The C FFI crate `ifc-lite-ffi` now fails to compile under `panic = "abort"`, for example a plain `cargo build --release`, because its `catch_unwind` guards would be no-ops there; build it with `--profile server-release`, as its documentation already required.
