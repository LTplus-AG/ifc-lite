---
"@ifc-lite/data": major
"@ifc-lite/parser": major
"@ifc-lite/rules": patch
"@ifc-lite/export": patch
---

STEP re-export no longer turns a source `FILE_NAME` author or organization of `$` (or `($)`) into `()`, which is not a valid `LIST [1:?]` and failed IfcOpenShell validation. The exporter now writes its `('')` default for those (#5470).

BREAKING: `IfcSourceHeader.author` and `.organization` (re-exported by `@ifc-lite/parser`, and returned by `parseSourceHeader`) are now optional. They are absent when the source wrote `$`, a list of only unset entries, or no `FILE_NAME` record. They are `[]` only for a literal `()`, which still round-trips as `()`. Code that reads them must handle `undefined`, e.g. `header.author ?? []`.
