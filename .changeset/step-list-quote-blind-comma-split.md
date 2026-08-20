---
"@ifc-lite/data": patch
---

Fix `parseStepValue`/`parseStepList` corrupting a STEP list whose string member contains a literal comma.

`parseStepList` split at every top-level comma while tracking paren/bracket nesting but not quote state, so a string list member with a comma inside it — legal STEP content, and exactly what an `IfcLabel`/`IfcText` value (a description, an address line, ...) is free to contain — split mid-string: `('a,b','c')` came back as `["'a", "b'", "c"]` instead of `['a,b', 'c']`. `@ifc-lite/parser`'s `source-header.ts` had already solved this exact problem for STEP header fields with a quote-aware `splitTopLevel` and documented why a quote-blind splitter mis-splits; this generic list parser — re-exported as the public `parseStepValue` from both `@ifc-lite/data` and `@ifc-lite/parser` — had the same gap. `parseStepList` now tracks single-quoted string state (with `''` escapes) the same way, so parens/brackets and commas inside a quoted member no longer perturb the split.
