---
"@ifc-lite/export": patch
---

`StepExporter` now honours a quantity set the session DELETED.

It withholds a source `IfcElementQuantity` when it is writing a replacement for it, and a deletion has no replacement to be recognised by, so a deleted set stayed in the exported bytes while the panel showed it gone. #2487 wrote that rule when `MutablePropertyView` had no public quantity-set delete; `deleteQuantitySet` (#2508) gives it one, so the exporter asks `isQuantitySetDeleted` as well.

Behaviour is unchanged for every session that does not delete a quantity set, which is every session before this one could exist.
