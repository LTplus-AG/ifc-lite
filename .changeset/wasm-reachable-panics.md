---
'@ifc-lite/wasm': patch
---

Return errors instead of trapping the wasm instance on bad input (#7677). The release build aborts on a Rust panic, so each of these used to kill the whole instance:

- `exportMerged` with malformed `lengths` still throws, but the `IfcAPI` handle can now be reused and freed afterwards.
- A progress callback that calls `setGeometryProgressCallback` from inside itself no longer traps.
- `splitMeshByZones` skips a zone with an `Infinity` or `NaN` parameter.
- `planAppearance` with an evaluated occurrence whose shared Body has `*` as its context excludes that product.
- A LandXML stream session closes after its first parse error, so later chunks return an error.
- A near-zero-length LandXML irregular line returns an error.
