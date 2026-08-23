---
"@ifc-lite/data": patch
---

Fix `EntityTableBuilder.build()` producing a `typeRanges` entry that does not contain every row of its type when an IFC stream interleaves types.

A type's range is a SPAN — `[firstRow, lastRow + 1]` — which is what `entityTableFromColumns` derives when a caller omits the map (worker-transport rebuild, cache load). The builder instead computed `start + rowCount`, the row COUNT, so for rows 0/2/4 of one type it emitted `[0, 3)` and left row 4 outside the type's own range. The two producers sit in the same module and nothing made them agree; they coincide for every contiguous type, which is what every fixture was, so the divergence was invisible. Both now emit the same span.
