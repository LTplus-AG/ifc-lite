---
"@ifc-lite/semantic": minor
---

Add `inspectReadOnlyQuery`, which applies the same read-only refusals as `assertReadOnlyQuery` and also returns the query form, the outer projected variables (or `'*'`) and the outer LIMIT, so a caller can check a drafted query against its declared shape before running it (#6920).
