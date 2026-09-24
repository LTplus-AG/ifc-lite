---
"@ifc-lite/ids": patch
---

IDS external-reference classifications (#5249): an authored typed value (e.g. an `IfcIdentifier` whose text is `#22` or `$`) is read as its text instead of being re-parsed as a reference or unset token.
