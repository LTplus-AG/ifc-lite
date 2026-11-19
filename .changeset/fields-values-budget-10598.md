---
"@ifc-lite/viewer": patch
---

The `fields.values` agent operation no longer fails on models with many long material or classification names. Its five fields share the operation result limit, and a new optional `truncated` list names any field that was cut to fit.
