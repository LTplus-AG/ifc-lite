---
'@ifc-lite/mutations': major
---

`CsvConnector.generateMutations` silently wrote `0` for a Real/Integer property whenever the source CSV cell wasn't a number at all (`"N/A"`, `"TBD"`, a blank cell after a bad delimiter split, ...). `parseFloat(value) || 0` and `parseInt(value, 10) || 0` both coerce `NaN` to `0`, so an unparseable cell produced a mutation indistinguishable from a genuinely-imported zero, applied to the model with no error and no warning.

`parseValue` now returns a private sentinel for a Real/Integer cell that fails to parse, and `generateMutations` skips that cell instead of writing the fabricated `0` — matching how the sibling Express-ID match strategy already handles an unparseable numeric column (`isNaN` guard, warning, no phantom match). `generateMutations` also takes an optional `warnings` array to report which cells were skipped and why; `import()` and `importAsync()` now pass their own `stats.warnings` through it, so a CSV import surfaces the skip instead of hiding it.

A genuinely-zero cell (`"0"`) still writes `0` as before — only cells that don't parse as a number at all are skipped.

A `List` cell is handled the same way. The branch used to choose between the two accepted encodings by catching a `JSON.parse` throw, so a malformed JSON list fell through to the semicolon path and `[1,2` was imported as the one-element array `['[1,2']`, the same fabricated value the sentinel exists to prevent. The encoding is now resolved in three steps: a valid JSON *array* wins, a semicolon marks the other form, and only a cell that starts with `[`, carries no semicolon, and still will not parse is skipped and reported. Valid JSON that is not an array (`5`, `{"a":1}`) is not a list, so it takes the semicolon path and becomes a one-element list exactly as it did before. Semicolon-separated lists are unaffected, including ones whose entries are bracketed (`[EXT];[LOAD]`).
