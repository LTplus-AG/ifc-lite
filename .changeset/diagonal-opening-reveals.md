---
"@ifc-lite/wasm": patch
---

Fix diagonal and roof-window reveal faces so oblique multilayer wall parts keep
their opening soffits within the actual wall geometry, and BRep roof openings
preserve their full sloped opening frame instead of falling back to world axes.
