---
"@ifc-lite/query": patch
---

Fix `ifc-lite query`'s DuckDB SQL integration reading a NULL string-typed property as an empty string instead of SQL `NULL`.

`createPropertiesTable` (duckdb-integration.ts) resolved `PropertyTable.valueString` with `valueStringIdx >= 0 ? ... : ''`. `valueString` is a `Uint32Array`, so the NULL sentinel written by `StringTable.intern(null)` (-1) wraps to 4294967295 rather than going negative — the `>= 0` check was always true and never caught it, and the row was inserted with `value_string = ''`, indistinguishable from a genuine empty-string property. `WHERE value_string IS NULL` silently matched nothing.

Two siblings on the same column family already guard this correctly: `getPropertyValue`'s String branch in `@ifc-lite/data`'s `property-table.ts` and its cache-restored twin in `@ifc-lite/cache`'s `properties.ts`, both checking `idx < strings.count`. This DuckDB path is named as a sibling in `property-table.ts`'s own doc comment ("the on-demand fallback in `@ifc-lite/query`") but used an independent, unguarded decode. The fix extracts the shared logic into `resolveDuckDBStringLiteral` and applies the same in-range check, emitting the bare `NULL` keyword — matching how this same file already handles the `containedInStorey`/`definedByType` sentinels a few lines above.
