---
'@ifc-lite/data': minor
---

Fix `QuantityTable.getForEntity` silently merging two distinct `IfcElementQuantity` instances into one when they share a literal name, misattributing the second instance's quantities to the first instance's GlobalId — the quantity-side counterpart of the same fix on `PropertyTable`.

An entity can carry two rows whose `qsetName` is identical but whose `qsetGlobalId` (the real quantity-set identity) differs — a federated merge of two files, or an exporter that emits the same `Qto_` set twice on one element, both produce this. `getForEntity` grouped rows into a `Map<string, QuantitySet>` keyed on `qsetName` alone, so the second instance's rows landed in the first instance's bucket. `getForEntity` now groups on `(qsetName, qsetGlobalId)`, so two same-named-but-distinct instances stay separate while rows that genuinely belong to one instance still merge exactly as before.

`QuantityTable`/`QuantityTableColumns` gain a `qsetGlobalId: Uint32Array` column (mirroring `PropertyTable.psetGlobalId`), and `QuantitySet` gains an optional `globalId?: string` field reporting the resolved identity. The row-builder field is optional (`qsetGlobalId?: string`, defaulting to `''`), so every existing `QuantityTableBuilder.add(...)` call site in the repo keeps compiling unchanged; two rows that both omit it still merge as before.
