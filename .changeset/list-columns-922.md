---
"@ifc-lite/lists": minor
---

Add material, classification, and storey list columns (#922).

`ColumnDefinition.source` gains `material` | `classification` | `spatial`
(storey). The engine resolves them via the optional `ListDataProvider`
material/classification/storey accessors; material and classification cells
are de-duplicated and joined.
