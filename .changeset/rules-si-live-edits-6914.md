---
"@ifc-lite/rules": patch
---

A `property` or `quantity` filter rule with `valueUnit: 'si'` (or `inherit`) now reads unsaved in-session edits through the model's mutation view in search and filters, the same overlay plain property rules read, instead of the file as loaded. The edited value keeps its unit, so it is still converted to SI. Validation still reads the model as loaded.
