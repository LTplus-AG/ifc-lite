---
"@ifc-lite/parser": patch
---

Say when `IfcComplexProperty` nesting was cut short instead of stopping silently at the depth cap (issue #3972). A complex property nested deeper than 8 levels used to degrade to the bare `UsageName`, which is indistinguishable from a complex property that genuinely has no nested content; when the capped node had no `UsageName` the whole nested member vanished and its parent's own `UsageName` was shown in its place, so the reader saw a real value attributed to the wrong nesting level. The value now carries a `(truncated: nesting deeper than 8 levels)` suffix, byte-identical to the server's `resolve_complex_property_value`. The cap itself is unchanged — it is what makes a self-referencing `HasProperties` chain terminate.
