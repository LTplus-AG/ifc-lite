---
"@ifc-lite/viewer": minor
---

Replace the SQL tab in the advanced search modal with a clean
chip-based **Filter** tab. Storey / IFC type / Predefined type / Name /
Property / Quantity rules compose with AND/OR + IsSet/IsNotSet and
run through an in-memory evaluator that scales to 4M-entity models
via `entityIndex.byType` / `spatialHierarchy.byStorey` prefilter,
cheap-first per-entity rule ordering, and async chunked yielding
with cancel + progress. The DuckDB engine, SQL editor, schema
browser, templates, error rewriter, and saved-SQL-queries module
have been removed — Builder is the whole UI now, with a single Run
button and CSV/JSON export. Builder dropdowns are schema-aware
(storeys + IFC types load eagerly, pset / qto names load lazily on
first use), the inline search-bar query promotes to a Name rule
with one click, multi-model row clicks route to the correct model,
and saved presets persist named `{name, combinator, rules}`
snapshots in localStorage.
