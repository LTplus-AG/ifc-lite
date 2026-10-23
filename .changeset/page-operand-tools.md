---
'@ifc-lite/cli': patch
'@ifc-lite/sdk': patch
'@ifc-lite/create': patch
'@ifc-lite/data': patch
"@ifc-lite/wasm": patch
---

Keep a PAGE directive's apostrophe operand (`'Para \S\' 5'`) inside its STEP string in the CLI's extract, subset, validate and mutate scanners, the cost-removal reference guard, group-graph reference reads and list parsing. They closed the string at the operand, which dropped real references, shifted argument slots and read `#N` text as a reference.

The geometry content hash (Rust, shipped in `@ifc-lite/wasm`) also walks STEP strings by the shared rule, so a record holding a PAGE-operand literal hashes the same as its equivalent text.
