---
"@ifc-lite/viewer": minor
---

Unify search and filtering in the advanced search modal. The visual builder
now drives a single `FilterRule[]` shape (storey / IFC type / predefined
type / name / property / quantity, with AND/OR + IsSet/IsNotSet) that
compiles to either DuckDB SQL or runs through a new in-memory path-B
evaluator — Fast Run works without `@duckdb/duckdb-wasm` installed and
covers every loaded model. Builder dropdowns are schema-aware (storeys
+ IFC types load eagerly, pset / qto names load lazily on first use), and
the inline search-bar query can be promoted to a Name rule with one click.
