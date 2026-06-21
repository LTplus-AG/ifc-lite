---
"@ifc-lite/wasm": minor
---

Skip tiny detail cuts in the preview tessellation tiers (#1286).

In the `Lowest`/`Low` tessellation tiers, an `IfcBooleanResult` DIFFERENCE whose
cutter's max dimension is below 10% of the host's (a small steel cope/notch, a
minor detail recess) is now skipped and the host renders un-cut. On
boolean-heavy Tekla steel models the exact `subtract` per cut dominates load
time and almost every cut is such a small local notch, so dropping them in the
preview tiers recovers Manifold-class load times (170_KM geometry ~7.6 s →
~1.1 s, ~6.9×) with no parallelism and full determinism. `Medium` (the default)
and finer keep every cut — byte-identical to before. The threshold is tunable
natively via `IFC_LITE_FAST_CUT_RATIO`.
