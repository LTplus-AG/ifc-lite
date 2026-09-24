---
"@ifc-lite/wasm": patch
---

The native (Rust) STEP exporter now reconciles enum members the target schema does not define, matching the TypeScript exporter (#5365). The same generated decisions apply: `.USERDEFINED.` with the member name in the label slot, else `.NOTDEFINED.`, else `$` for an optional attribute, else refused (kept as written and reported). They are counted in `ConversionReport::enum_values_lost` and `ConversionReport::enum_values_refused` (from `export_step_with_report`), and named in merged-export warnings. The table (`rust/export/src/generated/enum_reconciliation.rs`) is written by `scripts/generate-enum-reconciliation.mjs` in the same pass as the ledger.
