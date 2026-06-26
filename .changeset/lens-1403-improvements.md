---
"@ifc-lite/lens": patch
---

Lens `equals` matching now compares boolean values case-insensitively. IFC booleans surface in the properties panel capitalized (`True` / `False`), but `String(boolean)` is lowercase, so a rule typed as the value the user sees never matched. Non-boolean strings stay case-sensitive so codes and ratings keep matching exactly. (#1403)
