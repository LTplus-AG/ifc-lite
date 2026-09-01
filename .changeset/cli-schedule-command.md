---
'@ifc-lite/cli': minor
---

Add `ifc-lite schedule <file.ifc> --type <IfcClass> --columns "<Header>=<path>[, ...]" [--where <expr>] [--format csv|json]`: a tabular schedule of one IFC class, one row per entity.

Each column is a `Header=path` pair (a bare `path` is its own header); `path` is a plain attribute name (`Name`, `Tag`, `GlobalId`, …), a `PsetName.PropName`, or a `QtoName.QtyName`. Property/quantity paths resolve through the same shared resolver `export` uses (so schedule columns inherit its type-inheritance / same-named-pset / complex-property behaviour), plain attribute names read from the canonical entity-attribute list, and `--where` reuses the exact filter `query` applies. CSV output routes every cell through the shared RFC-4180 escaper (formula-injection guard included); a missing value is an empty CSV cell / JSON `null`. Rows preserve entity iteration order (no sorting in this first cut).
