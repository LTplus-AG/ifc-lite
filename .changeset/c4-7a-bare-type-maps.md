---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Accept bare `IfcTypeProduct.RepresentationMaps` references in browser geometry discovery and in exported EntityRows, matching native geometry. Typed wrappers remain refused. Tabular and semantic exports now include orphan type rows for bare map references.
