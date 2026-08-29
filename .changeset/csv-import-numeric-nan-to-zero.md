---
'@ifc-lite/mutations': patch
---

`CsvConnector.generateMutations` silently wrote `0` for a Real/Integer property whenever the source CSV cell wasn't a number at all (`"N/A"`, `"TBD"`, a blank cell after a bad delimiter split, ...). `parseFloat(value) || 0` and `parseInt(value, 10) || 0` both coerce `NaN` to `0`, so an unparseable cell produced a mutation indistinguishable from a genuinely-imported zero, applied to the model with no error and no warning.

`parseValue` now returns a private sentinel for a Real/Integer cell that fails to parse, and `generateMutations` skips that cell instead of writing the fabricated `0` — matching how the sibling Express-ID match strategy already handles an unparseable numeric column (`isNaN` guard, warning, no phantom match). `generateMutations` also takes an optional `warnings` array to report which cells were skipped and why; `import()` and `importAsync()` now pass their own `stats.warnings` through it, so a CSV import surfaces the skip instead of hiding it.

A genuinely-zero cell (`"0"`) still writes `0` as before — only cells that don't parse as a number at all are skipped.
