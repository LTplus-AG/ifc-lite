---
'@ifc-lite/export': patch
---

A non-numeric value in a REAL-typed named attribute is no longer written as a
quoted string. `#2725` fixed the numeric case; a non-numeric one still fell
through and was quoted, producing the same ISO 10303-21 violation that fix
exists to prevent. `StoreEditor.setAttribute` takes a string, so any UI text
field bound to a georeferencing REAL could deliver one.

The slot now keeps the value the file had AND the export reports the dropped
edit through `stats.warnings`, so a discarded edit is visible rather than
inferred from its absence.
