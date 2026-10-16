---
'@ifc-lite/export': patch
---

STEP export: one non-finite policy. `toStepReal` now throws for NaN and the infinities instead of writing a made-up `0.`, an INTEGER property with no finite value below 1e21 is written as `$` (never `IFCINTEGER(NaN)` or `IFCINTEGER(1e+21)`), and a typed INTEGER marker of 1e21 or more is refused. Integral numbers of 1e21 or more in an untyped slot are written as a REAL. The Rust writer behaves identically, pinned by the shared parity vectors.
