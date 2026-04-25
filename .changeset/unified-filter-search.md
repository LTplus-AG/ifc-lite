---
"@ifc-lite/viewer": minor
---

Unify search and filtering in the advanced search modal. The visual builder
now drives a single `FilterRule[]` shape (storey / IFC type / predefined
type / name / property / quantity, with AND/OR + IsSet/IsNotSet) that
compiles to either DuckDB SQL or runs through a new in-memory path-B
evaluator — Fast Run works without `@duckdb/duckdb-wasm` installed and
covers every loaded model. When the inline search bar carries a query,
Fast Run automatically uses the Tier-1/Tier-0 hits as a per-model
candidate set, so structured rules only re-check the text-search
matches. Builder dropdowns are schema-aware (storeys + IFC types load
eagerly, pset / qto names load lazily on first use, schema cache is
dropped when a model unloads), and saved presets persist named
`{name, combinator, rules}` snapshots in localStorage. Multi-model row
clicks in the result table now route to the correct model.
