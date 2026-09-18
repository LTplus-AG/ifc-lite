---
"@ifc-lite/export": patch
---

A pending edit that set a STRING-typed root attribute (`Name`, `Description`, and other `IfcLabel`/`IfcText` slots) to `''` used to export as `$`, collapsing an explicit empty string to absent. `serializeStringSlot` now keeps STEP's distinction between `''` (present, empty) and `$` (not set): only the literal `$` (or `*`, the derived-value marker) still serializes as the null marker, matching IfcOpenShell and the read-model fix in #4881/#4909 (#4931).
