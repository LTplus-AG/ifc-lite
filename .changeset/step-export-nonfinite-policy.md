---
'@ifc-lite/export': patch
---

STEP export: one non-finite policy. `toStepReal` now throws for NaN and the infinities instead of writing a made-up `0.`, an INTEGER property with no finite value below 2^53 is written as `$` (never `IFCINTEGER(NaN)` or `IFCINTEGER(1e+21)`), and a typed INTEGER marker beyond 2^53 is refused. Integral numbers beyond 2^53 in an untyped slot are written as a REAL. The Rust writer behaves identically, pinned by the shared parity vectors.
