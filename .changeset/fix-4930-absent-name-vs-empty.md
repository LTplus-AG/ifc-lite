---
"@ifc-lite/data": major
"@ifc-lite/parser": patch
---

`EntityTable` gains `getNameOrUndefined(expressId)`, a display-neutral sibling of `getName` that returns `undefined` for an entity whose `Name` attribute is genuinely absent (STEP `$`) instead of folding it into `''` the way `getName` still does for every existing display caller. **Major, not minor**: `getNameOrUndefined` is a REQUIRED interface member (not optional), so any downstream implementation of `EntityTable` (a typed mock, a third-party table) that doesn't already provide it fails to compile — a source-breaking change, not an additive one. `EntityTableBuilder.add`'s `name` parameter now accepts `string | undefined` so a builder can record that distinction in the first place, and the columnar parser (`@ifc-lite/parser`) now passes a real `undefined` through for an absent `Name` instead of coercing it to `''` before the entity table ever sees it (#4930).
