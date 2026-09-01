---
'@ifc-lite/wasm': patch
---

The structured JSON and JSON-LD exporters (`rust/export`'s `export_json`/`export_jsonld`, reachable via `@ifc-lite/geometry`'s `GeometryProcessor.exportJson`/`exportJsonld` and the CLI's `--format jsonld`) no longer silently turn a non-finite quantity or numeric property into JSON `null`.

A STEP `REAL` literal with an extreme exponent (e.g. `1.0E400`) parses to `f64::INFINITY` without erroring in the decoder, so it is reachable from real, if adversarial, input, not just a computed value. `serde_json`'s `Number::from_f64` returns `None` for a non-finite float, and `json!`/`Value::from` map that to `Value::Null` — the value silently vanished, indistinguishable in the output from the quantity being absent. `finite_json_number` now falls back to the value's `f64::to_string()` form (`"inf"`/`"-inf"`/`"NaN"`) instead, so the measurement survives as a string rather than disappearing. A plain finite value is unaffected — it still serializes as a JSON number.
