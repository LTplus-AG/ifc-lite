---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Faster exact CSG kernel (stage 2a): f64 interval tier for `cmp_along` (tri-tri ordering).

Closes the last plan-flagged float-filter hole on top of the interval-lambda filter: the 1-D ordering of tri-tri crossing points (`cmp_along`) went straight to the I512 tier then BigRational with no interval pre-filter. `interval::cmp_along` (a pure-f64 directed-rounding mirror of `fixed::cmp_along`) now runs first; `tritri.rs` falls to I512/BigRational only on a zero-straddle. Because the interval is outward-rounded (no FMA), a definite sign equals the exact sign and is bit-identical native==wasm==x86_64==aarch64 — manifest constant and snapshots unchanged. Cumulative with the interval-lambda filter: native geometry ~4.2s → ~2.8s.
