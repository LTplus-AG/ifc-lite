---
"@ifc-lite/wasm": patch
---

The native (Rust) STEP exporter now reports the invalid IFC4 file that a schema downgrade from IFC4X3 or IFC5 produces when it leaves `$` in a slot IFC4 requires, such as `IfcProjectedCRS.Name` (#5307, the Rust twin of #5202). The report is `StepStats::ifc4_required_slots_unfilled` for single-model export and a `stats.warnings` entry for merged export. The converter never invents a value. It reads the same generated IFC4 required-slot table as the TypeScript exporter; `scripts/generate-ifc4-required-slots.mjs` now writes both languages in one pass.
