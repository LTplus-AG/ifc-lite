---
"@ifc-lite/data": minor
---

Add `isCompleteStepNumericLiteral(token)`, the single STEP REAL/INTEGER grammar check shared by every STEP token reader. `parseStepValue` now uses it, so a corrupted literal such as `1.52.3` (a dropped comma) comes back as its raw token rather than silently truncated to `1.52`.
