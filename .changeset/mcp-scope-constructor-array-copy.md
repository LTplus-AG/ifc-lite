---
"@ifc-lite/mcp": patch
---

`fullScope()` and `readOnlyScope()` now copy the `scopes` array as well as the
wrapper object. The shallow spread handed every caller the same array instance
as the exported `FULL_ACCESS` / `READ_ONLY` constants, so an in-place mutation
(`readOnlyScope().scopes.push('mutate')`) widened the constant itself and every
token minted afterwards in the same process carried the extra scope.
