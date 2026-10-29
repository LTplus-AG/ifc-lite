---
"@ifc-lite/semantic": patch
---

Resolve the N3 `Writer.end` callback with `value ?? ''` so the package still type-checks against `@types/n3` 1.26.5 and later, which type the callback result as possibly undefined.
