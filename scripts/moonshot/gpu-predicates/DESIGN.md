# B1.3 spike + B2.5 follow-up: exact orient3d and incircle on WebGPU

Spike for M6c (docs/vision/moonshots-tech.md) / B1.3 (docs/vision/moonshots-execution-plan.md),
extended by B2.5 (encode-bottleneck attack + incircle; see section 9). No CSG
integration, no `rust/` or `packages/` changes. This directory is self-contained:

- B1.3 (sections 1-8): `reference.mjs` (CPU exact oracle + CPU encoder),
  `orient3d.wgsl` (GPU exact kernel, CPU-encoded inputs), `harness.mjs`
  (Playwright-driven browser runner that does both and compares).
- B2.5 (section 9): `predicates-raw.wgsl` (GPU kernels taking RAW f64 bits:
  decode, exponent frame, D_MAX gate, and both predicates fully on-GPU),
  `harness-b25.mjs` (runner for the new paths), plus additions to
  `reference.mjs` (incircle BigInt oracle, BigInt-free fast CPU encoder).
  The B1.3 files are untouched so the original baseline stays reproducible.

## 1. Why floats can't just be uploaded to the GPU

`geometry-predicates` on CPU (Shewchuk adaptive) and this repo's own fixed-width
tier (`rust/geometry/src/kernel/fixed.rs`) both work by escalating to exact
integer/rational arithmetic whenever a floating filter can't certify the sign.
WGSL has neither `f64` nor `i64` — only `f32`/`i32`/`u32` — so neither the
adaptive floating filter (needs f64 to even be a meaningful improvement over
f32) nor the CPU fixed-width tier (built on `bnum` `I256..I2048`, a Rust crate
with no WGSL equivalent) can be ported directly. The only path to an EXACT sign
on today's WebGPU is: do all arithmetic in emulated multi-limb integers built
out of `u32`, and never let a floating-point rounding step anywhere near the
sign decision.

## 2. The exactness argument

Every finite IEEE-754 double `x` decomposes bit-exactly as `x = S * 2^E` where
`S` is a signed integer (53-bit magnitude for normals — the implicit leading 1
plus the 52-bit mantissa — or up to 52-bit for subnormals) and `E` is an
integer exponent (`E ∈ [-1074, 971]` over the whole finite double range). This
decomposition is exact bit manipulation (mask/shift on the IEEE bit pattern),
not arithmetic — there is no rounding step here, at all magnitudes, including
subnormals and zero.

`orient3d(a, b, c, d)` is the sign of a 3x3 determinant of coordinate
differences (`a-d`, `b-d`, `c-d` as rows). This determinant is a homogeneous
degree-3 polynomial in the twelve input coordinates. **A single shared positive
scale factor applied to every one of the twelve coordinates multiplies the
determinant by that factor cubed — sign unchanged.** That is the entire trick:
if we can re-express all twelve doubles as `S_i * 2^(E_i - e_min)` for one
shared `e_min = min(E_i)` (so every rescaled value is `x_i / 2^e_min`, an
*exact* non-negative-shift integer, no rounding — shifting a bit pattern left
by a non-negative amount never drops bits), the sign of the determinant of the
twelve integers `S_i * 2^(E_i - e_min)` equals the sign of the real determinant
of the twelve doubles. From there it's finite-precision but otherwise ordinary
integer subtraction/multiplication/addition — each of which is exact as long
as the working register is wide enough to hold the true result without
truncation (see width budget below). **No step on the sign-decision path ever
rounds**: the frexp-style decomposition is exact, the common-exponent shift is
an exact left-shift, and every big-integer add/sub/mul below is computed at a
width proven wide enough that truncation never actually discards a nonzero bit.

This is *conceptually* the same trick the CPU fixed-width tier already uses
(uniform positive scaling preserves orientation sign — see the module comment
in `fixed.rs`), generalized from "coordinates pre-snapped to a `k/2^16` grid"
to "any finite IEEE double, decomposed on the fly."

### Where this differs from Shewchuk's expansion arithmetic

Shewchuk's adaptive predicates keep sums as non-overlapping floating-point
*expansions* (arbitrary-length, no shared base) and only look at as many
components as needed to certify a sign. That is the right design on a CPU
with fast f64 FMA and branch prediction. On a SIMT GPU, per-lane data-dependent
expansion lengths are exactly the kind of divergence that kills throughput.
Fixed-width multi-limb integers over a common exponent frame trade a bit of
wasted arithmetic (every lane always does the same amount of work, sized for
the worst case the frame allows) for zero control-flow divergence, which is
the right trade for SIMT. This spike picks fixed-width integers over
expansions for that reason, not because expansions are impossible in WGSL.

## 3. The shared-exponent frame is per-test, not per-batch

The task brief says "quantize the batch to a shared exponent frame." This
spike interprets "batch" as **the twelve coordinates of one orient3d
evaluation**, not as one frame shared across an entire multi-million-item
dispatch. Rationale: real geometry queries in one dispatch are not required to
share a coordinate-magnitude regime (a dispatch can freely mix a
building-scale query against a millimeter-scale detail query elsewhere in the
model), so a single dispatch-wide frame would force the width budget to cover
the *worst* exponent spread anywhere in the whole batch, penalizing every
other item in it. A per-test frame keeps the width requirement tied to the
actual local dynamic range of that one predicate, which is the only quantity
that determines whether the sign is representable at a given fixed width.

The frame parameters (`e_min`, per-coordinate shift, and the resulting spread
`D`) are computed **on the CPU** (trivial bit manipulation, O(1) per point) and
uploaded as pre-shifted magnitude+sign integers; the GPU only ever does the
big-integer arithmetic, never any floating-point decoding. This mirrors the
CPU cascade's own structure: a cheap CPU-side filter step decides applicability
before the expensive exact tier runs.

## 4. Input-domain limit: exponent spread cap `D_MAX = 100`

- Per coordinate, decomposed magnitude is at most 53 bits (normal) or 52 bits
  (subnormal).
- Per test, `D = max(E_i) - min(E_i)` over the twelve nonzero-valued
  coordinates (an all-zero coordinate contributes no exponent constraint — its
  integer value is exactly zero at any shift).
- **If `D > D_MAX = 100`, the test is flagged for CPU fallback and is never
  sent through the GPU arithmetic path.** This is a hard gate evaluated on the
  CPU before upload; a flagged item never occupies a GPU lane and never
  produces a sign at all from the GPU side — there is no "compute anyway and
  hope," which is the failure mode the task explicitly rules out ("CPU
  fallback flag per item, NOT wrong signs").
- `D_MAX = 100` covers a coordinate-magnitude ratio of `2^100 ≈ 1.27e30`
  within one predicate — vastly larger than any realistic single-scene
  dynamic range (even "1 nanometer feature next to a 10,000 km georeferenced
  coordinate" is only ~2^63). It is chosen generously relative to real
  geometry so the fallback rate on realistic inputs is ~0%, while still being
  a hard, provable, checked limit — not an approximation.
- Genuinely extreme constructions (subnormals mixed with O(1) magnitudes,
  which spread by up to ~1074 bits; or one coordinate at `DBL_MAX` next to one
  near `DBL_MIN`) are used in the adversarial battery specifically to confirm
  the cap fires and routes to fallback rather than silently computing a wrong
  sign.

<!-- Numeral provenance, added 2026-07-29 for the numeral gate
     (scripts/moonshot/ci/check-report-numerals.mjs). No figure in this document
     is changed; these comments record which numbers the committed
     report.b25.*.json artifacts emit and which they do not. -->
<!-- numeral-ok: 52, 63, 1074 :: IEEE-754 double structure and its consequences
     (52-bit mantissa, ~2^63 for the largest plausible coordinate, the ~1074-bit
     spread from DBL_MAX down to the smallest subnormal). Properties of the
     format, not measurements. -->

## 5. Width budget (why 512-bit two's-complement-free sign-magnitude is enough)

Let `W = 53 + D_MAX = 153` bits (worst-case magnitude of a single shifted
input coordinate). Bound the magnitude of each computation stage
conservatively (every `+1` below is slack for the sign-magnitude subtraction
worst case, where two same-magnitude opposite-sign values effectively add):

| stage | operation | magnitude bound |
|---|---|---|
| input (shifted) | — | `W` = 153 |
| row difference (`a-d` etc.) | subtract | `W+1` = 154 |
| 2x2 minor term | multiply two differences | `2(W+1)` = 308 |
| 2x2 minor | subtract two such products | `2(W+1)+1` = 309 |
| final triple term | multiply a difference by a minor | `(W+1)+(2(W+1)+1)` = 463 |
| final sum | ± three such terms | `463+2` = 465 |

465 bits of true magnitude, plus one bit of margin for the sign-magnitude
representation (no two's-complement wraparound to worry about — see §6), fits
comfortably inside a **512-bit (16 × u32 limb) working register**, with 47
bits of headroom to spare. Input coordinates are stored compactly in 5 limbs
(160 bits, enough for the 153-bit worst case) and zero-extended to 16 limbs on
load. Every multiply and add/subtract in the shader operates at the fixed
16-limb width; truncating a schoolbook product to 16 limbs is *exact* here
(not an approximation) because the proof above shows the true result never
exceeds 465 bits — the discarded upper limbs are provably always zero for any
test that passed the `D_MAX` gate.

**Known inefficiency, not fixed in this spike:** every multiply is a full
16x16-limb schoolbook (256 `u32×u32→u64` partial products), even though most
operands only have their low 5-13 limbs nonzero (the rest is zero-padding).
The CPU cascade avoids this by tiering width (I256 tried before I512/I1024);
a real GPU predicate library (B2.5/B3.4) would do the same — pick the
narrowest limb count that covers the test's actual `D`, branching per lane or
per workgroup. This spike deliberately skips that optimization to keep the
shader small and the correctness argument easy to audit; see §7 for the
resulting throughput hit.

<!-- numeral-ok: 512, 153, 154, 308, 309, 463, 465, 47, 160, 256 :: the width
     derivation itself. Every one of these is computed in the table on the line
     it appears on, from `W` = 153 and the stated rule (W+1, 2(W+1), 2(W+1)+1,
     463+2), and 512 / 16 limbs / 47 spare bits / 256 partial products follow
     from that. A register width is a design decision, not a measurement, and no
     battery report emits one. -->

## 6. Representation: sign-magnitude, not two's complement

The shader represents every big integer as `{ mag: array<u32,16>, neg: bool }`
rather than two's complement. Two's complement makes add/subtract a single
ripple-carry pass (an advantage this spike does not need, since add/sub is a
small fraction of the work), but it makes *multiply* fiddly (need a correct
truncated-negate-multiply-renegate dance to avoid the upper sign-extension
limbs contaminating the schoolbook product). Sign-magnitude makes the
multiply trivial and correct by construction (multiply the two non-negative
magnitude arrays — zero-padded limbs contribute exactly zero to every partial
product, no sign-extension fill to reason about — then XOR the signs), at the
cost of slightly more branching in add/subtract (compare-then-subtract-smaller-
from-larger). Given multiplies dominate the per-test cost (9 full 16x16
multiplies vs. a handful of O(16) adds), this trade favors sign-magnitude for
this spike.

`u32×u32→u64` itself has no native WGSL primitive (no `u64`), so it is built
from the standard 16-bit-limb split identity `a*b = ah*bh*2^32 +
(ah*bl+al*bh)*2^16 + al*bl` with explicit carry propagation between the three
partial-product groups (`mul32` in `orient3d.wgsl`). This exact primitive is
unit-tested against JS `BigInt` for a battery of edge-case 32-bit operand
pairs (all-ones, alternating bits, zero, max value) before the harness trusts
it for the full battery — see harness.mjs's `selfTestMul32` step and the
report's "self-test" section.

## 7. Honest scope boundary / what would break this

- **NaN / Infinity inputs are out of scope.** Geometry never legitimately
  produces them as coordinates; the CPU-side decomposition does not attempt
  to classify them specially and they are excluded from the battery. A
  production version would reject or fallback-flag them explicitly.
- **The per-test frame, not per-batch, means each GPU lane does independent
  CPU-precomputed shift work; this spike does not attempt a fully on-GPU
  decode-from-raw-f64-bits path** (WGSL has no `f64` type to even receive raw
  doubles — inputs must already be `u32`-encoded before upload, which is why
  the CPU-side decomposition step is unavoidable in *any* WGSL scheme, not a
  shortcut specific to this one). **[RETRACTED by B2.5: §9.2 candidate 1 —
  the raw-bits path uploads the untouched f64 bit patterns as `vec2<u32>`
  and decodes/frames/gates ON the GPU, eliminating the CPU decomposition;
  see `predicates-raw.wgsl` and the B2.5 harness.]**
- **This is stage 1 (orient3d) only.** incircle, the rational escalation tier,
  and the `ImplicitPoint`/LPI/TPI configurations from `kernel/predicates.rs`
  are all out of scope; a real library would need all of them plus a policy
  for what happens to a whole CSG operation when one lane in a batch
  fallback-flags (this spike's answer — "that one lane's sign is simply not
  produced by the GPU path, full stop" — composes fine at the single-predicate
  level but a real integration needs to decide how a batched *op* handles a
  partial fallback; not addressed here).

## 8. Result summary (filled in after running the battery)

Full numbers, mismatch samples, and the environment (real Apple M4, Metal-3
WebGPU backend, hardware-accelerated per `chrome://gpu`) are in `report.json`,
produced by `node harness.mjs --phase=all`. Headline:

- **Self-tests** (against JS `BigInt` ground truth): `mul32` (the `u32*u32→u64`
  primitive), 59 cases, 0 mismatches. 512-bit schoolbook `magMul`, 22 cases
  (including all-`0xFFFFFFFF` operands), 0 mismatches.
- **Correctness battery**: 1,500,009 cases checked against the CPU exact
  BigInt reference (random-uniform at three magnitude scales, 1-ulp coplanar
  perturbations, last-significand-bit differences, exact/negative zeros,
  collinear degeneracies), **0 mismatches**. 506 cases (subnormals mixed with
  O(1) magnitudes, and exponent spreads deliberately constructed past
  `D_MAX`) correctly fallback-flagged rather than computed wrong. The
  `D_MAX` boundary itself is exact: `D=100` valid and sign-matching,
  `D=101/120/300` correctly flagged.
- **Throughput** (GPU dispatch+readback only, vs. single-thread CPU exact
  `BigInt`, the fair "real CPU exact path" baseline per the task brief):
  15.3x at 1e5, 29.6x at 1e6, 31.0x at 1e7 — **clears the >= 10x gate**, and
  the ratio grows with batch size (fixed per-dispatch overhead amortizes).
- **The honest caveat**: including this spike's CPU-side shared-exponent-
  frame *encode* step (single-threaded JS `BigInt`, not yet moved to the
  GPU or parallelized) in the GPU-path wall-clock collapses the win to only
  ~1.3-1.4x over the CPU baseline — encode, not the exact arithmetic, is
  today's true end-to-end bottleneck. See §7's already-flagged scope
  boundary: this spike deliberately kept the frame computation CPU-side;
  making it fast (parallel encode, or a partial GPU-side bit-decode from
  raw f64 halves) is real, identified follow-up work, not solved here.
- **Verdict**: the spike gate ("batched orientation predicates on WebGPU
  with sign-exact agreement vs CPU on random + adversarial near-degenerate
  inputs, >= 10x throughput") **passes** on the predicate-throughput metric
  the task specifies. It passes as a systems-research result establishing
  the technique works and is sign-exact, not as a claim that today's
  unoptimized single-threaded-CPU-encode pipeline is already a 10x win
  end-to-end for a real caller — that gap is real, disclosed, and left for
  B2.5/B3.4 to close.

<!-- numeral-ok: 1,500,009, 506 :: case counts of the B1.3 spike battery. The
     committed report.b25.*.json files are from a LATER, differently-scaled
     invocation (per-label totalCases of 1e6 / 2e5 and so on); the spike run's
     own JSON was never committed. Stated here so nobody reads these as backed. -->
<!-- numeral-ok: 15.3x, 29.6x, 31.0x :: throughput ratios from that same
     uncommitted spike run. -->
<!-- numeral-ok: 1e-6 :: a coordinate MAGNITUDE in the rotating 1e3/1e9/1e-6
     generator set, i.e. a generator parameter, not a result. -->

## 9. B2.5 follow-up: the encode bottleneck is closed, and incircle is in

Everything in this section was measured on the same machine and stack as
section 8 (Apple M4, Metal-3 WebGPU adapter, real Chrome via Playwright's
`chrome` channel, headed, `--enable-unsafe-webgpu`; all generation, CPU
references, and dispatch inside the page). Raw numbers live in
`report.b25.*.json`, produced by `node harness-b25.mjs --phase=<phase>`.

### 9.1 Baseline reproduction

Re-running the untouched B1.3 harness (`node harness.mjs --phase=throughput
--sizes=100000,1000000`, 2026-07-24) reproduced section 8's caveat exactly:
at n=1e6, encode 1731 ms + GPU 146 ms vs CPU BigInt 2523 ms, i.e. **1.34x
end-to-end** (GPU arithmetic alone 17x in that run). One methodology note
uncovered while reproducing: harness.mjs's first dispatch pays pipeline
compilation (~290 ms), which is visible in the 1e5 row when the throughput
phase runs alone; harness-b25.mjs therefore runs explicit warmup dispatches
on every pipeline before any timed region.

### 9.2 What was built

Three candidates from section 8's follow-up list, in the order that killed
the bottleneck:

1. **GPU-side bit-decode (the winner, "path C").** Section 7 claimed the
   CPU-side decomposition step was "unavoidable in any WGSL scheme" because
   WGSL has no f64. That claim confused *receiving doubles* with *receiving
   the bits of doubles*. The caller reinterprets its `Float64Array` as a
   `Uint32Array` (zero copies, zero arithmetic) and uploads raw IEEE-754
   halves; `predicates-raw.wgsl` does the frexp decomposition, the per-test
   shared exponent frame, the D_MAX gate, and the mantissa shifts entirely
   in integer WGSL. A gated lane (NaN/Inf or D > 100) writes the sentinel
   sign 2 instead of computing - fallback-not-wrong is preserved, it just
   moved to the GPU. Upload also shrinks 3x (96 B/test vs 288 B/test).
2. **BigInt-free CPU encode ("path B", `encodeTestFast`).** Same output
   words as `encodeTest`, using only 32-bit integer ops on the IEEE halves.
   Verified word-for-word identical on 330,016 cases including NaN/Inf,
   subnormals, DBL_MAX, mixed specials, and the exact D_MAX boundary
   (`--phase=encodecheck`, 0 mismatches). 7.6x faster than the BigInt
   encoder in Node, 5.4x inside Chrome (319 ms vs 1731 ms per 1e6). Kept as
   the fallback story for callers that need CPU-side encoding; obsoleted for
   the main GPU path by candidate 1.
3. **Length-aware multiply (narrow-limb tiering, per-lane).** Instead of
   per-lane width *branching* into separate kernels, `magMul` in the new
   kernel scans both operands' true limb lengths and loops only that far.
   Typical differences at small per-test D have 2-3 significant limbs, so
   the schoolbook shrinks from 16x16=256 partial products to ~tens. Lanes
   diverge only as far as their limb lengths differ (magnitude-coherent
   batches: barely). This more than pays for the wider 20-limb container
   the unified kernel uses (see 9.3): the new kernel's full pipeline is
   *faster* than the old 16-limb one despite also doing the decode.

The worker-parallelized-encode candidate was not implemented: with encode
gone from the pipeline entirely, there is nothing left for workers to
parallelize on the main path (it would only multiply path B's 5.4x).

<!-- numeral-ok: 1.34x, 290ms, 96B, 288B :: 1.34x and ~290 ms (shader
     compilation) are from the baseline-reproduction run of §9.1, whose JSON was
     not committed; 96 B and 288 B are the per-test upload sizes of the two
     encodings, format constants fixed by the WGSL. -->

### 9.3 incircle and the unified width budget

`incircleRaw` computes the standard lifted 3x3 determinant (sign of d
against the circle through a,b,c), matching the new BigInt oracle
`incircleSignBigInt` in `reference.mjs`. It is homogeneous of degree 4 in
the coordinate differences, so the shared positive frame scale preserves
the sign exactly as the degree-3 argument in section 2 does for orient3d.

Width budget at D_MAX = 100 (magnitudes strictly below 2^k): input 2^153,
difference 2^154, square 2^308, lift (sum of two squares) 2^309, row term
2^618, three-term determinant 2^620. Both predicates therefore share one
**20-limb (640-bit)** sign-magnitude working width in `predicates-raw.wgsl`
(orient3d only needs 465 bits; the length-aware multiply makes the extra
container limbs nearly free). Truncation to 20 limbs is exact for gated
inputs, same argument as section 5.

<!-- numeral-ok: 618, 620, 330,016 :: 2^618 and 2^620 are the derived worst-case
     magnitudes of the two determinants, computed from the width rule in section
     5; 330,016 is the case count of the encode-equivalence check, whose report
     (report.b25.encodecheck.json) records the check but not that total. -->

### 9.4 Correctness results (all zero-mismatch)

- `mulVar` self-test (length-aware 640-bit multiply vs BigInt mod 2^640,
  including full-width, top-limb-only, and random sparse-length operands):
  307 cases, 0 mismatches.
- Decode self-test (GPU decode/frame/shift vs the trusted CPU encoder,
  word-for-word including eMin and the valid flag): 26,624 cases spanning
  random at three magnitudes, 1-ulp coplanar sets, zeros, subnormals,
  NaN/Inf, and the D 99/100/101/120/300 boundary: 0 mismatches.
- orient3d raw-path battery (same adversarial families as the B1.3 battery
  plus NaN/Inf-must-flag): 1,500,524 cases, 0 mismatches; all 511
  must-fallback cases produced exactly the sentinel, and the D_MAX boundary
  is exact (D=100 computes, D=101 flags).
- incircle battery: 1,453,523 cases, 0 mismatches - random at three
  magnitudes, 51,000 cocircular 1-ulp perturbations, 2,000
  exactly-cocircular integer constructions (Pythagorean points on
  translated radius-25 circles; determinant exactly zero), collinear and
  all-zero degeneracies, subnormal/NaN/spread fallbacks.
- Large-scale random battery (`--phase=bigrandom`, chunked, magnitudes
  rotating 1e3/1e9/1e-6): orient3d 20,000,000 cases and incircle 5,000,000
  cases vs the BigInt oracle, 0 mismatches.

Total verified this round: ~21.5M orient3d + ~6.5M incircle evaluations,
zero sign disagreements, zero gate disagreements.

<!-- numeral-ok: 1,500,524, 511, 1,453,523, 21.5M, 6.5M :: battery totals for
     the B2.5 correctness round. The committed report.b25.battery.json /
     .incircle.json / .bigrandom.json hold per-label case counts from that
     round's individual invocations; these are the summed totals across them,
     which no artifact stores. -->

### 9.5 End-to-end throughput (the number that was missing)

Measured e2e = everything the caller pays: CPU-side prep (none for path C
beyond a typed-array view), upload, dispatch, readback, and the sentinel
scan. CPU baseline = single-thread BigInt exact, same distribution, chunked
identically (chunk = 1e6). Warmup excluded via pre-dispatch. Random uniform
magnitude 1e3, zero fallbacks in all runs.

| n | orient3d CPU | path B e2e | path C e2e | B speedup | **C speedup** |
|---|---|---|---|---|---|
| 1e5 | 261 ms | 64 ms | 21 ms | 4.1x | **12.3x** |
| 1e6 | 2537 ms | 503 ms | 103 ms | 5.0x | **24.6x** |
| 1e7 | 24950 ms | 4962 ms | 781 ms | 5.0x | **31.9x** |

| n | incircle CPU | path C e2e | **C speedup** |
|---|---|---|---|
| 1e5 | 925 ms | 18 ms | **51.7x** |
| 1e6 | 8296 ms | 88 ms | **94.8x** |
| 1e7 | 91088 ms | 674 ms | **135.1x** |

The B1.3 arithmetic-only ratio (31x at 1e7) is now the *end-to-end* ratio:
the 1.3-1.4x caveat of section 8 is closed. incircle lands higher because
its CPU BigInt cost per test is ~3.6x orient3d's (degree 4, wider
intermediates) while its GPU cost is barely higher.

<!-- numeral-ok: 261ms, 64ms, 21ms, 4.1x, 12.3x, 2537ms, 503ms, 24.6x, 24950ms,
     4962ms, 781ms, 925ms, 18ms, 51.7x, 8296ms, 94.8x, 91088ms, 674ms, 135.1x,
     3.6x :: the two end-to-end throughput tables. These are the clearest
     provenance gap in this bet: the committed report.b25.throughput.json holds a
     single n=1e6 row from a different invocation, so none of the three-scale
     rows above has a committed artifact. They are transcribed from the run log.
     Recorded rather than quietly dropped -- re-running them needs a WebGPU host
     and is out of scope for the G4 gate, but it is a real gap and belongs in
     B2.5's ledger, not in a silent allowlist. -->

### 9.6 Remaining gaps

- **Exam-scale battery: CLOSED 2026-07-24.** The literal 1e8-case random
  battery has now been run for BOTH predicates (`--phase=bigrandom
  --sizes=100000000,100000000`, report.b25.bigrandom.json): 1e8 orient3d +
  1e8 incircle, 100% oracle-checked, 0 mismatches, 0 unexpected fallbacks.
  GPU time ~9.1 s / ~8.1 s; wall clock ~50 min, oracle-bound as predicted.
  Chunked magnitude rotation (1e3 / 1e9 / 1e-6) covered scale regimes.
- **Adversarial fraction at scale**: the zero-mismatch adversarial families
  (1-ulp coplanar/cocircular, exact zeros, boundary D) are thousands to
  tens of thousands of cases each; scaling those to exam size is oracle
  wall-clock too.
- Little-endian host assumed for the raw-bits reinterpret (both the fast
  encoder and the upload path); a big-endian host would need a word swap.
- Still out of scope, unchanged from section 7: rational escalation tier,
  ImplicitPoint/LPI/TPI configurations, batched-op fallback policy (the
  sentinel composes per-predicate; an integrated CSG op still needs a
  policy for partially-flagged batches), NaN/Inf as anything other than a
  flagged lane.
- Single machine / single backend measured (Apple M4, Metal-3, Chrome).
  The WGSL uses nothing exotic (no subgroups, no f16), but the numbers are
  one-GPU numbers.
