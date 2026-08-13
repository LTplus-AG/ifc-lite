---
"@ifc-lite/extensions": patch
---

Internal tidy-up only, no behaviour change: the sandbox's `try { value = fn(...) } catch (err) { throw err }` is now a plain call, which is what rethrowing an unchanged error already did.

This ships because the repo's new lint gate flagged it (`no-useless-catch`), not because anything was wrong at runtime.
