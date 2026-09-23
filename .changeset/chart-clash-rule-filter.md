---
"@ifc-lite/charts": minor
---

`ChartSourceFilter` gains an optional `clashRule` field so a `clash` chart can be built from ONE detection rule/run instead of every rule of the current clash result being counted together (#5156). Absent means every rule, same as before; `validate.ts` rejects it on any source other than `clash`.
