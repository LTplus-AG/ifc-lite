---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Faster exact CSG kernel: cached f64 interval-lambda predicate filter (one canonical kernel).

Stage 1 of migrating the exact predicate cascade off WASM-emulated wide-integer
(I512) arithmetic toward the modern "spend the budget in the float filter" design
(Cherchi/Attene). The exact kernel's hot re-triangulation predicates resolved via
the cached I512 lambda determinant, which WASM emulates ~hundreds× slower than
native's hardware path — on opening-dense models that bignum dominated worker CPU.

The interner now caches a directed-rounding **f64 interval lambda** per point
(alongside the existing I512 lambda). `orient2d_v`, `cmp_lex_v`, and the interner's
dedup compare run a pure-f64 interval determinant from it FIRST, falling to the
exact I512/BigRational tiers only on a genuine zero-straddle. Because the interval
is outward-rounded (no FMA), a definite sign equals the exact sign and is
bit-identical across native/wasm/x86_64/aarch64 — the `indirect_sign_manifest`
constant and the geometry-correctness snapshots are unchanged (determinism
preserved, no drift, no parallel path).

Result on ISSUE_068 (opening-dense facade): native geometry 4.2s → 2.9s (−30%,
benefits the server too), WASM load 46s → 41s. Byte-identical mesh output; full
geometry suite green (53/53 binaries, manifest + snapshots unchanged). Follow-ups
extend the same filter to the remaining bignum sites and add a float-expansion
exact tier for the degenerate tail.
