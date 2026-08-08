---
"@ifc-lite/geometry": patch
---

`exportStep` now doubles a literal reverse solidus (`\`) inside STEP string literals, matching the apostrophe doubling it already did. ISO 10303-21 requires both `'` and `\` to be doubled in a string literal; only the apostrophe was, so a property or pset name containing a Windows path or a regex (e.g. `C:\temp`, `Pset_MyProps\Sub`) was written as an under-escaped, non-conformant literal. Values that are already STEP-serialized (`AttrMutation.value` / `PropMutation.value`) are untouched — only the property/pset name and header fields that flow through this exporter's own `escape()` are affected. Strings with no `'` or `\` are emitted byte-identically, as before.
