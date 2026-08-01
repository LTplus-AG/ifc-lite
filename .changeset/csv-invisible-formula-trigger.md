---
"@ifc-lite/sdk": patch
---

Guard spreadsheet formula triggers hidden behind an invisible character in `bim.export.csv()`.

The CWE-1236 escape tested for a leading `=`, `+`, `-`, `@`, tab or carriage return with an anchored regex, so a trigger sitting behind a byte-order mark, zero-width space, left-to-right mark, right-to-left override or non-breaking space did not match. A spreadsheet still evaluates such a cell, so a value like `\uFEFF=HYPERLINK(...)` (a literal byte-order mark before the `=`) was exported unguarded. IFC text properties are author-controlled and survive round-trips, so a model can carry any of them.

The trigger is now looked for past leading `\p{Cf}` and `\p{Zs}` characters. Not `\s`, which would swallow a leading tab, and tab is itself a trigger.
