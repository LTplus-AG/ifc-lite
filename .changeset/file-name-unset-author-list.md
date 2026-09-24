---
"@ifc-lite/data": minor
"@ifc-lite/parser": patch
"@ifc-lite/rules": patch
---

STEP re-export no longer turns a source `FILE_NAME` author or organization of `$` into `()`, which is not a valid `LIST [1:?]` and failed IfcOpenShell validation. `IfcSourceHeader.author` and `.organization` are now optional: absent when the source wrote `$` (or had no `FILE_NAME` record), so the exporter writes its `('')` default, and `[]` only for a literal `()`, which still round-trips as `()` (#5470).
