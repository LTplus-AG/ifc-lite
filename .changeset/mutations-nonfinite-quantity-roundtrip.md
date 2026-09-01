---
'@ifc-lite/mutations': patch
---

`MutablePropertyView.exportMutations()` no longer lets a non-finite quantity value (`NaN`/`Infinity`/`-Infinity`) collapse to `0` across `importMutations()`. `JSON.stringify` maps a non-finite number to `null`, and the quantity replay path (`applyMutations`) did `Number(mutation.newValue)`, where `Number(null)` is `0` — so a serialize→deserialize round trip silently changed the value, even though applying the same mutations directly (no serialization in between) preserved it exactly. `exportMutations`/`importMutations` now wrap a non-finite `newValue`/`oldValue`/whole-set member `value` in a JSON-safe marker and restore it on import; an ordinary finite value is unaffected, and a string property value is never mistaken for the marker.
