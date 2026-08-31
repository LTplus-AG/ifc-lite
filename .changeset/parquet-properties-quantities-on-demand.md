---
'@ifc-lite/export': patch
---

`ParquetExporter.exportBOS()`/`exportTable('properties'|'quantities')` wrote a zero-row `Properties.parquet` and `Quantities.parquet` for every model parsed the normal way — `Entities.parquet` and `Relationships.parquet` alongside them fully populated. `IfcParser.parseColumnar` (the only parse path used by every real caller) never bulk-populates `store.properties`/`store.quantities`; it serves them lazily through `onDemandPropertyMap`/`onDemandQuantityMap` and `store.getProperties()`/`store.getQuantities()` instead. The two writers read the never-populated bulk tables directly, so the gap was silent: no error, no warning, just an empty table next to full ones. Verified independently — DuckDB opened the exported `.bos` archive and read back 0 rows from both tables against a real fixture carrying thousands of property/quantity relationships.

Both writers now fall back to the on-demand path (through the same `store.getProperties()`/`store.getQuantities()` accessor every other consumer uses) when the bulk table is empty but on-demand data exists, and keep the existing bulk-table path for stores that populate it directly. `Quantities.Formula` is NULL on the on-demand path — the on-demand quantity reader carries no formula string, only the bulk-table path can populate it.
