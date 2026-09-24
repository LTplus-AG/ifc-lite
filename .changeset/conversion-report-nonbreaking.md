---
"@ifc-lite/wasm": patch
---

The native (Rust) STEP exporter reports what a schema conversion could not settle through a new `ConversionReport` instead of new `StepStats` fields, so the change is additive for Rust callers. The report covers IFC4-required `$` slots (#5307) and enum members the target lacks (#5365), and is returned by `export_step_with_report`. `ConversionReport` is `#[non_exhaustive]`, so it can grow later without breaking anyone. `StepStats` is back to its published shape, and the Rust crates stay at 17.x (`majorOffset` 8).
