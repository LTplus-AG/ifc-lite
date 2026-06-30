---
"@ifc-lite/lens": minor
---

Classification auto-color legends now show the human-readable name alongside the
system and code (#1460). An entry reads e.g. `Uniclass: EF_25_10 (Walls)` instead
of just `Uniclass: EF_25_10`. Grouping is unchanged - it still keys off
`System: Code`, so the same code never fragments across slightly different names;
the name is purely a label, taken from the first reference seen for that code, and
the parenthetical is dropped when the name merely repeats the code.
