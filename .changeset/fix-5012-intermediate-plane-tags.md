---
"@ifc-lite/wasm": patch
---

Fixed opening cuts that could lose wall geometry after an intermediate boolean difference inherited union-specific plane consolidation tags. Difference and intersection output now use the established geometric plane derivation; precise kernel plane tags remain enabled for unions.
