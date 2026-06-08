# IFC-lite Canonical CSG Kernel — Hardened Design (pure-Rust exact mesh arrangement)

> Living design doc. To be committed as `docs/architecture/pure-rust-csg-kernel.md`.
> Status: implementation-ready. Every critical/high refutation is folded in and the fix is stated inline (search "REFUTATION-FIX").

## 0. North star and the single seam

ONE arrangement kernel + ONE exact half-space clip kernel sit behind `ClippingProcessor` (`rust/geometry/src/csg.rs`), exposing exactly four ops — `subtract_mesh` (`csg.rs:894`), `union_mesh` (`csg.rs:1278`), `intersection_mesh` (`csg.rs:1341`), `clip_mesh` (`csg.rs:1628`) — plus the derived batch helpers (`subtract_box` `csg.rs:663`, `union_meshes` `csg.rs:1387`, `subtract_meshes_batched` `csg.rs:1429`, `subtract_meshes_with_fallback` `csg.rs:1468`). These signatures and the never-`Err` contract are FROZEN. Each `#[cfg(feature="manifold-csg")]`/`#[cfg(not)]` body pair (`csg.rs:907/972`, `1286/1305`, `1346/1357`) collapses to one unconditional kernel call. `bsp_csg.rs`, `manifold_kernel.rs`, the `manifold-csg`/`-sys` deps, and `default=["manifold-csg"]` (`Cargo.toml:21`) are deleted in the FINAL commit, after the verify gate is green.

> REFUTATION-FIX (L5-flaw "single kernel"): the design no longer claims ONE kernel. It is **one seam, two internal kernels**: (A) the exact mesh-arrangement kernel (winding-vector classified, for closed-operand booleans) and (B) the exact half-space clip kernel (orient3d-sign plane clip, for unbounded `IfcHalfSpaceSolid` and the open-slab `clip_mesh`). `clip_mesh` produces OPEN meshes (`layers.rs:489-501` chains two clips and keeps an open `SubMesh`), and winding-number classification is undefined on open meshes — so `clip_mesh` is a first-class kernel-B op, NOT an arrangement fast path. Hard rule: a chained PBHS operand must be rebuilt from the SOLID, never fed from a prior `clip_mesh` output.

**Determinism bar (USER DECISION 1):** TOPOLOGY-identical across x86_64/aarch64/wasm, NOT bit-identical coordinates. Achievable because only predicate SIGNS need match, and signs are integer parity over deterministic expansion arithmetic — proven platform-identical for explicit predicates by floor spike #1016 (fingerprint 302063904). The hardening below proves the *whole pipeline* (not just predicate signs) is topology-deterministic, because vertex identity, fast-path snap, processing order, map iteration, and tie-breaks are ALL additional topology inputs (see L3/L5 determinism discipline).

---

## L1 — EXACT PREDICATES

Modules: `kernel/predicates.rs` (explicit + indirect dispatch), `kernel/expansions.rs` (thin re-export of geometry-predicates substrate), `kernel/indirect.rs` (LPI/TPI construction + indirect orient2d/orient3d), `kernel/interval.rs` (hand-rolled directed-rounding interval), `kernel/rational.rs` (num-rational oracle).

### Substrate decision (corrected rationale)
Adopt **`geometry-predicates 0.3` (MIT, `#![no_std]`, zero deps)** as the single substrate for BOTH explicit predicates AND the expansion arithmetic of the indirect layer. Drop `robust`.

> REFUTATION-FIX (L1-flaw "robust FMA"): the rejection of `robust` is NOT "its FMA was never audited" — that premise is FALSE (`robust-1.2.0` is also `mul_add`-free, same `SPLITTER=134_217_729`). The correct, verified reason: `geometry-predicates` **`pub`-exports** `two_sum`/`two_product`/`split`/`scale_expansion_zeroelim`; `robust` keeps them **private** (`fn`, not `pub`), so it cannot supply the indirect-layer expansion substrate. `geometry-predicates` is verified `mul_add`-free with compile-time const error bounds (platform-independent), so the EXPLICIT path determinism holds.

### Symbolic point representation (never materialised to a decision)
```rust
pub enum ImplicitPoint {
    Explicit([f64; 3]),
    Lpi(Lpi),   // edge line ∩ triangle plane: 5 explicit input points
    Tpi(Tpi),   // three triangle planes concurrent: 9 explicit input points
}
pub struct Lpi { p:[f64;3], q:[f64;3], r:[f64;3], s:[f64;3], t:[f64;3] } // line PQ ∩ plane RST
pub struct Tpi { planes:[[[f64;3];3];3] }                                 // 3 faces × 3 pts
```
Cite: Cherchi/Livesu/Scateni/Attene 2020 §4.1; Attene CAD 2020 (arXiv:2105.09772v2) §4.

### λ-construction (degree-2 LPI, degree-3 TPI; identical in every tier, only the number type changes)
**LPI** (line `PQ` ∩ plane `RST`), homogeneous `(λx,λy,λz,d)`:
```
qp=Q−P; sr=S−R; tr=T−R; pr=P−R
d = det3(qp, sr, tr)
n = det3(pr, sr, tr)
λx = d·Px + n·(Qx−Px); λy = d·Py + n·(Qy−Py); λz = d·Pz + n·(Qz−Pz)
```
Cite: Attene 2020 §4.2.
**TPI**: Cramer on `N·x=c`, `nᵢ=(Bᵢ−Aᵢ)×(Cᵢ−Aᵢ)`, `cᵢ=nᵢ·Aᵢ` (un-normalised → all polynomials, no sqrt); `d=det3(n1,n2,n3)`. Cite: Attene 2020 §4.

### Indirect orient3d / orient2d — PER-CONFIGURATION sign rule (the critical fix)

> REFUTATION-FIX (L1-flaw #1, CRITICAL — the design's own pseudocode encoded the bug): the blanket "XOR parity over all negative denominators" rule is WRONG because it ignores per-term denominator MULTIPLICITY. Replace it with a per-(predicate, configuration) sign derivation, encoded as a const table and verified by the G3 oracle. The denominator polynomial `D′` and the flip rule for each instance (Attene 2020 §4.3–4.6, extracted verbatim):

> ⚠️ CONVENTION CORRECTION (M2.3 finding): the rows below quote Attene's RAW-Cramer-λ `D′`. The SHIPPED kernel pre-scales λ by one factor of `d` (`rational::lpi_lambda`: `λ = d·P − n·(Q−P)`), so the *projected* numerator `Λ′₂` is degree-1 (ODD) in `d`. The CODE is ground truth and is verified by `indirect_orient2d_matches_materialised_point` + the orient2d plane-winding-invariance test. Do NOT copy Attene's `D′` rows for the pre-scaled λ without dividing out the pre-scale; derive the flip from the materialised-point oracle. Corrected `orient2d 1I` row below.

| predicate | implicit args | `D′` (shipped, pre-scaled λ) | flip rule |
|---|---|---|---|
| orient2d | 1I | `d` (odd) | **flip on `sign(d)`** (NOT `d²`/no-flip — that is Attene's raw-λ convention) |
| orient2d | 3I | `d1²·d2·d3` | flip on `sign(d2)·sign(d3)` only (d1 squared) |
| orient3d | 1I (**LPI — the hot case**) | `d` (odd) | **MUST flip on `sign(d)`** |
| orient3d | 3I (TPI) | `(d1·d2·d3·d4)²` (square) | **NO flip** |
| mixed (IIE/IEE etc.) | — | product of the above, multiplicity-honored | parity over the odd-power denominators ONLY |

Implementation: generate separate `EEE`/`IEE`/`IIE`/`III` instances (mirroring Attene's code-generation structure — math only, no LGPL code copied). The flip is `sign(Λ′)` XORed with the parity of negative *odd-multiplicity* denominators, NOT "count all negative d's". Per-instance unit test asserts the sign equals an independent BigRational recompute. **Omitting/mis-applying the LPI flip silently inverts inside/outside for every host face whose winding makes `d<0` (≈half of real cuts), invisible to tri-count tests** → this is risk #1.

### orient2d projection-axis selection (correctness condition, not magnitude heuristic)
> REFUTATION-FIX (L1-flaw #4): drop the dominant axis is a HEURISTIC, not the correctness condition. The condition (Attene §4.5) is: pick any axis `i` for which the EXACT `orient2d` of the three plane-defining points projected ⊥ to `i` is **nonzero**. Use "largest normal magnitude" only as the first candidate; on an exactly-zero projected determinant, fall through to the next axis. Selection is a pure function of input bytes (no float-magnitude tiebreak that can diverge across platforms on ~45° faces). Adversarial near-axis-aligned-plane test added to G3.

### 3-tier (really 4-stage) evaluation cascade
> REFUTATION-FIX (L1-flaw #2, HIGH — the "no semi-static filter on the indirect path" claim contradicts Attene §5.1 and forfeits the fastest tier, attacking the perf gate): the indirect path DOES admit a semi-static filter — just not the explicit `o3derrbound` permanent. Stages:
- **Explicit args:** delegate to `geometry_predicates::orient3d(...).signum()` (Shewchuk semi-static filter free).
- **Indirect args, stage 0 — semi-static filter on the indirect `Λ′` polynomial:** a purpose-built roundoff bound for the LPI/TPI `Λ′` (Attene §5.1 / Appendix A; derive the bound from the indirect polynomial degree using the const-epsilon scheme). Resolves the vast majority of indirect calls in one comparison.
- **stage 1 — f64 interval filter** (only when stage 0 fails).
- **stage 2 — expansion arithmetic** over geometry-predicates primitives.
- **stage 3 — `num-rational` BigRational** exact oracle.
Cite: Attene 2020 §5/§5.1/§5.2; Cherchi 2020 §4.1. **Cache λ-intervals AND the stage-0 bound per implicit point** (dominant perf lever; Attene §2.1: intervals 3–8× plain FP).

### Interval arithmetic — explicit directed-rounding construction (no fesetround)
> REFUTATION-FIX (L1-flaw #3, HIGH — the "(1+n·ulp) fudge factor" is a hand-wave; Attene §5.2 uses `fesetround(+∞)` which wasm cannot do): specify a `RnInterval{lo:f64, hi:f64}` with OUTWARD widening on EVERY primitive op (not a final fudge):
- `add/sub`: compute round-to-nearest, then `lo = next_down(lo)`, `hi = next_up(hi)`.
- `mul`: compute all four endpoint products, take min/max, widen both outward by one ULP; **special-case multiplication of zero-straddling intervals** (the non-trivial soundness case) — result must bracket `[min, max]` of the four corner products with outward widening.
- `next_up`/`next_down` via integer bit-twiddle (NOT `f64::next_up`, whose const-eval behavior is not guaranteed identical across targets) — verified bit-identical across x86_64/aarch64/wasm as a standalone G2 determinism test.
Soundness obligation: a property test asserts the interval ALWAYS brackets the BigRational exact value across a fuzz battery on all three targets. Conservative = false-escalate fine, false-certify FATAL.

### Coordinate window — assert, NEVER clamp
> REFUTATION-FIX (L1-flaw #7): a clamp silently moves a vertex = silent sign change. Replace "assert/clamp" with **assert-then-route-to-BoolFailure**. Compute the safe exponent budget from the highest-degree polynomial actually evaluated: TPI is a degree-3 Cramer determinant; the `Λ′` for `orient3d-3I` reaches ~`coord⁶` (≈1e42 for 1e7 coords — still inside `geometry-predicates`' ~`[1e-142,1e201]` window). The budget is COMPUTED, not assumed 1e21. An operand exceeding the budget (e.g. a national-grid model where RTC re-detection failed, per georef-jitter memory) drains a `BoolFailure(CoordinateOutOfRange)` and returns the un-cut host (frozen never-Err). Real RTC-rebased inputs (~1e0–1e7) are safe. Cite: Attene 2020 experiments coords `[1,1000000]`.

### Determinism enforcement (CI-gated)
- CI grep ban: `rg 'mul_add|\.fma\(' rust/geometry/src/kernel` must be EMPTY (Rust never auto-contracts `a*b+c`).
- > REFUTATION-FIX (L1-flaw #5): the FMA proof is scoped to the LIBRARY (verified clean), NOT the hand-written indirect layer. The grep is necessary-not-sufficient. The REAL proof is G2 running the hand-written LPI/TPI λ/det and indirect orient2d/orient3d on the adversarial battery across x86_64/aarch64(real ARM runner)/wasm32, asserting byte-identical SIGN manifests. Until G2 runs on the indirect layer, indirect topology-determinism is UNVERIFIED (listed top gap).
- `d==0` (line∥plane, coincident/parallel planes) ⇒ LPI/TPI constructor REFUSES a point (no intersection — correct). Detected exactly in stage 3.
- **DELETE** the float-tolerant `clip_triangle` epsilon path (`csg.rs:545`, `d0 >= -self.epsilon`) — replaced by exact orient3d-sign half-space clip (kernel B).

---

## L2 — GEOMETRY KERNEL (broadphase + tri-tri + re-triangulation)

### BVH — hand-rolled f64 median-split AABB tree, reusing `rust/clash/src/bvh.rs`
parry3d is NOT in the tree (only `nalgebra`/`simba`); the clash tree adds ZERO deps; parry is f32-default, removed `Qbvh` in 0.22, has a 0.26.1 determinism regression + enhanced-determinism-vs-simd conflicts, drags `spade`/`rstar`/`ena`. Mirror the clash tree in f64 (`kernel/broadphase.rs`).
**Determinism safety:** the float SAH/median-split never DECIDES topology — it is a conservative *superset* candidate-pair filter; exact predicates decide. **Positive AABB pad only** + adversarial coincident-face test.
> REFUTATION-FIX (determinism-flaw "BVH pair ORDER"): pair SET being platform-identical does NOT make pair ORDER identical, and the clash sort is a float `partial_cmp` with `Equal`-on-tie (`bvh.rs:119-122`). After broadphase yields the candidate SET, **canonicalise processing order from EXACT keys**: sort pairs by `(min input-tri-id, max input-tri-id)`; within a triangle, sort inserted points/segments by the exact implicit-point lexicographic comparator (Cherchi 2020 §4.3) BEFORE re-triangulation. The float BVH sort is acceptable only because its order never reaches output; a G2 test asserts the canonicalised pair-set hash is identical across the 3 targets.

### Tri-tri intersection + re-triangulation
- Tri-tri detect: exact Guigue-Devillers via `orient3d` on EXPLICIT input points; classify empty/point/segment/coplanar-polygon. Cite Cherchi 2020 §5.1.
- Re-triangulation (`kernel/retriangulate.rs`): constrained in-plane over mixed explicit+implicit points via `orient2d_i`; primitive = Livesu-2021 O(n) deterministic fan. CDT-with-symbolic-perturbation documented as fallback. Do NOT adopt `spade` (materialises crossings to float `Point2` — violates carry-symbolically) or `earcutr` (no constraint edges) for the arrangement core; `spade` may stay a dev-dep cross-check.
> REFUTATION-FIX (determinism-flaw "fan order-sensitivity" + "cocircular-square tie"): the Livesu fan is NOT proven order-invariant by assertion. Two fixes: (1) feed the fan its points in **canonical exact order** (the lexicographic implicit comparator) so insertion order is fixed and platform-independent; (2) specify the **explicit exact tie-break** for the degenerate cocircular-square / collinear case where every orient2d/incircle is exactly zero: break by **lexicographically-least exact vertex key** (canonical input-index tuple), stated as a HARD rule in `retriangulate.rs`, never deferred to "G2 will catch it" (G2 detects divergence, it does not prevent it). With these, `incircle`/`insphere` are unneeded (only CDT needs `incircle`).

---

## L3 — ARRANGEMENT (candidate pairs → conforming, intersection-free complex)

Flattened triangle soup, each tri tagged operand `i∈0..n` (Cherchi-2022 §4). Pipeline:
- **Phase 2 — Intersection detection** (Cherchi 2020 §5.1): per canonical-ordered candidate pair, exact tri-tri; genuine crossing → an LPI `{2 line + 3 plane}` indices; coincident vertex/edge adds to the split list without a new point; coplanar pairs → §5.4 auxiliary-tetrahedron handling. Build per-triangle `{points, segments}`.
- **Phase 3 — Point insertion** (§5.2): split triangles before edges; locate sub-tri by exact point-in-triangle = three `orient2d_i` signs all-same; interior → 3 children, edge → 4. Sub-tri vertices carry implicit coords → INDIRECT orient2d. Edge-point sort via the exact implicit comparator (§4.3).
- **Phase 4 — Segment insertion** (§5.3, Algorithm 1): walk the edge fan, delete incident tris, insert constrained edge, re-triangulate half-pockets (canonical-ordered Livesu fan). Seg-seg interior crossing ⇒ ≥3-tri concurrence ⇒ TPI from 3 linearly-independent planes (9 indices), split, recurse; if 3 independent triangles can't be found → coplanar §5.4 path.

### Vertex identity — symbolic/exact, NEVER a float-rounded bucket (critical)
> REFUTATION-FIX (determinism-flaw #1, CRITICAL — quantisation is FATAL, not coordinate-only): the L5 weld (`manifold_kernel.rs:41-43`, `(v*1e6).round()`) and `geom_hash` use float-rounded buckets. The bar ALLOWS ~1-ULP coordinate drift; a vertex near a half-cell boundary buckets to DIFFERENT integers across platforms → different vertex identity → different adjacency → DIFFERENT TOPOLOGY (reproduced: scale 1e6, `0.0000004999999`→0 vs `0.0000005000001`→1). This re-introduces divergence AFTER the exact core finishes. Fixes:
1. **Inside L3/L4:** two arrangement vertices are "the same" iff **symbolically/exactly equal** (same explicit input vertex, or LPI/TPI built from the same input-index tuple). Compare symbolic identity, never rounded coords.
2. **At the L5 input weld** (polygon-soup operands with genuinely different float coords at coincident corners): do NOT round-to-grid. Snap-merge by an EXACT predicate certifying coincidence at the seam tolerance, merge target = lexicographically-least exact key (not "first in a HashMap"). If a float pre-bucket is kept for speed it must only ever GROUP candidates (conservative coarsening at ≥1e-3, the existing seam tolerance, coarse enough that no real distinct vertices and no allowed 1-ULP drift straddle a boundary); the actual merge decision is exact.
3. Cross-arch test: feed the SAME operand with coords perturbed ±1 ULP, assert identical weld output.

Output of L3 = ONE conforming, intersection-free simplicial complex; every sub-tri references its originating input tri (operand tag).

---

## L4 — CLASSIFICATION (winding-number VECTOR per cell, Zhou-2016)

Decisive over Cherchi-2022 ray-cast: Zhou makes every op a pure boolean `f(w)` on `w=[w1..wn]`, so N-ary union/intersection + redundant-void dedup + #960 fall out free. Cite: Zhou/Grinspun/Zorin/Jacobson SIGGRAPH 2016 §3.2 Eq.3–6, §5.2–5.5.1.
- **Phase 5 — Cells** (§5.2): manifold-edge patches; radial-sort incident patches around each directed non-manifold edge via exact `orient3d` → above/below cells per oriented patch → cell-patch graph; nested components by point location (§5.5.1); one ambient cell.
- **Phase 6 — Winding propagation** (§5.3 Eq.7): seed ambient `w=[0..0]`; BFS, crossing oriented patch `p` of mesh `i`: `wn = wc + sp·[δ..]`, `sp=+1` if current cell above `p` else −1. Purely combinatorial. Postcondition: adjacent cells differ by exactly ±1 in exactly slot `i`.
- **Phase 7 — Extraction** (§5.4): evaluate `f(w)` per cell; emit triangles separating TRUE from FALSE, flip when TRUE cell is above, purge zero-total-signed-occurrence duplicates.
- **Phase 8 — To-float + L5 seam:** implicit→explicit float ONCE here (output only, never a decision). Cite §5.6.

> REFUTATION-FIX (determinism-flaw "radial tie on coincident faces", in-scope #964/#960/flush walls): when two operand faces are EXACTLY coplanar/coincident, orient3d between their patches is ZERO → no radial order. Specify Zhou's secondary ordering using an EXACT canonical key (operand-stable patch id from sorted exact vertex tuples + orientation), never input/HashMap order. Adversarial fixture: two exactly-coincident coplanar operand faces (#964 double-encoded void, #960 seam) cross-arch, asserting identical cell-patch graph and identical `f(w)`.

> REFUTATION-FIX (determinism-flaw "HashMap iteration order"): HARD rule + CI grep — NO `FxHashMap`/`HashMap` may have its `.iter()/.values()/.keys()/.drain()` order reach kernel output or seed any emitted traversal. Cell graphs, patch adjacency, winding-propagation seeds, and extraction use **`BTreeMap` keyed on exact integer/symbolic keys**. FxHashMap allowed only for pure membership/count lookups whose iteration order is never observed. (The legacy `merge_coplanar_bucket` `next_edge` FxHashMap iteration at `csg.rs:206-214` is exactly the hazard being banned.)

### The API ops as predicates on the vector
| op | `f(w)` | Zhou cite |
|---|---|---|
| `subtract_mesh(host=0,void=1)` | `w0≠0 ∧ w1=0` | Eq.5 |
| `union_mesh` | `∃i: wi≠0` | Eq.3 |
| `intersection_mesh` | `∀i: wi≠0` | Eq.4 |
| N-ary subtract (#960) | `w0≠0 ∧ w1=0 ∧ … ∧ wk=0` | Eq.5 generalised |
| `clip_mesh(plane)` | kernel B (orient3d half-space) — NOT an arrangement cell | — |

---

## STRUCTURED FAST PATHS (internal runtime dispatch, NOT flags, provably consistent)

> REFUTATION-FIX (perf-flaw "95% coverage double-counts", HIGH): the ~86% rectangular openings DISPATCH TO AABB BOX CLIP (`voids.rs:1330-1349`, `cut_rectangular_opening_no_faces` `voids.rs:2363`), which NEVER calls `subtract_mesh`. Only `OpeningType::NonRectangular` reaches `clipper.subtract_mesh` (`voids.rs:1427`). So coverage MUST be measured against the real `subtract_mesh`/arrangement-eligible corpus, NOT total openings. Re-baseline obligation (M0): instrument the current pipeline to count ops actually reaching `subtract_mesh`/`clip_mesh`, exclude rectangular AABB clips and `IfcHalfSpaceSolid` plane clips, and prove tier-1 2D-reextrude is not slower than the box clip it replaces on the rectangular-through-opening class (i_overlay i32-snap + retriangulate + re-extrude is MORE work than a box clip — a lateral move at best).

- **TIER-1 — 2D re-extrude:** plain `IfcExtrudedAreaSolid` host + coplanar-prismatic through-openings → subtract in the profile plane via `bool2d::subtract_multiple_2d` (`bool2d.rs:77`, i_overlay 6.0, no cap → round holes), re-extrude. Footprint guard via `projection_outline::mesh_outline_2d` (`projection_outline.rs:93`). Consistency: a prismatic through-cut's winding vector is constant along the extrusion axis, so `f(w)` reduces to the 2D point-in-`(profile−void)` test.
  > REFUTATION-FIX (determinism-flaw "i_overlay snap is bbox-dependent", HIGH — the BULK path): i_overlay's `FloatPointAdapter` derives `dir_scale=exp2(29−log2(max_half_extent))` from the input bbox then `((x−offset)*dir_scale).to_i32()` — both the bbox reduction and the truncation are float-decided, so a 1-ULP drift can flip `dir_scale` across a log2 boundary or push an endpoint across a grid line → different segment topology. Either (a) **quantise the operand to the seam grid with exact rounding BEFORE i_overlay and use `with_scale`/`with_offset` (fixed, NOT `new()`)** so `dir_scale` cannot jump, or (b) demote tier-1 to a SPEED-ONLY path re-verified per platform. Extend the consistency gate: **G4 asserts `fast_path(x86)==fast_path(aarch64)==fast_path(wasm)` connectivity**, not only `fast_path==forced_arrangement` on one host. If i_overlay cannot be made cross-arch-stable, the bulk window/door cuts fall to the exact arrangement and the perf gate is re-argued.
- **TIER-2 — exact half-space clip (kernel B):** for `IfcHalfSpaceSolid`/PBHS, classify each vertex by `sign(orient3d(plane_a,plane_b,plane_c,v))`, split straddling edges with one LPI each. Replaces the float `clip_triangle` (`csg.rs:545`).
  > REFUTATION-FIX (L5-flaw "half-space ≠ arrangement operand", HIGH): an unbounded `IfcHalfSpaceSolid` (`boolean.rs:150-244`, reduced to plane point+normal) has NO closed cutter and NO arrangement representation — winding is undefined for an unbounded operand. So `force_arrangement()` is unsatisfiable for it. Its consistency is gated WITHOUT an arrangement instance: (1) the G3 orient3d predicate oracle, plus (2) a **boxed-equivalence test** — close the half-space into a finite cutter box larger than the host AABB and assert the orient3d clip output equals the arrangement subtract of that box. State explicitly: half-space has no native arrangement representation; it is NOT gated by the fast-path≡arrangement fingerprint.
- **TIER-3 — full arrangement:** residual non-prismatic / non-coplanar / solid-solid.

**Consistency obligation (binding):** a test-only `force_arrangement()` builder flag (NOT a shipped cfg) forces tier-3 and asserts identical connectivity fingerprints on every fast-path-eligible fixture (except the unbounded half-space, gated by boxed-equivalence). Divergence → gate fails.

---

## L5 — IFC SEAM + GUARD RE-DERIVATION

### Never-`Err` contract — now also never-PANIC (critical)
> REFUTATION-FIX (L5-flaw #1, CRITICAL): the arrangement adds BigRational division, three-tier escalation, re-triangulation index walks, and radial sort — classic panic sites. A Rust panic UNWINDS THROUGH the `match Ok/Err` at `voids.rs:1427` — it is NOT caught by the never-Err wrapper → process abort on server / worker crash in wasm, strictly worse than today. Fix, per target:
- **Native (server):** wrap each of the four seam ops in `std::panic::catch_unwind` → on panic record `BoolFailure(KernelPanic)` + un-cut host.
- **wasm (catch_unwind unreliable):** the kernel must be **panic-free by construction** — checked indexing (no `[i]`/`unwrap` on the hot path), `d==0` refusal proven exhaustive, no `/d`. A CI no-panic fuzz (`refutation_fuzz.rs` over malformed cutters) asserts it on all targets.

### Boundary prep (mandatory, shared module lifted from `manifold_kernel.rs`)
`weld_vertices` (now EXACT-merge per L3 fix, not float bucket) + `reorient_outward` (union-find 2-tri edges, per-component BFS winding, whole-mesh signed-volume flip). IFC operands are 24-vert polygon soup with no shared-corner identity; winding classification is only meaningful on a welded, consistently-wound shell. DELETE `mesh_to_manifold_perturbed` (10µm crutch) and the `ManifoldOutputDegenerate` BSP retry. Output: `calculate_normals` + welded + `smooth_normals_with_creases(0.866)`.
> REFUTATION-FIX (determinism-flaw #2, HIGH — reorient signed-volume flip): `signed_volume_6x` (`manifold_kernel.rs:293-326`) is a naked f64 sum; on near-zero-volume/symmetric operands the sign differs across platforms → whole-shell inward flip → silent boolean inversion (House.ifc #3448 class), invisible to tri-count. Fixes: (1) compute the signed-volume sign with an EXACT tetra-volume expansion sum, escalating to num-rational on near-zero; (2) seed the BFS per-component with its **lexicographically-least exact vertex**, not `component[0]` from an FxHashMap (`manifold_kernel.rs:218-222`); (3) **OPEN DECISION → resolve to DELETE the global flip**: if L4 winding classification already fixes global orientation, drop `reorient_outward`'s whole-shell flip entirely — every retained float orientation decision at the seam is a determinism liability. Cross-arch test on a flipped + a symmetric box.

### Operand-builder unification (close gaps before the flip; corrected coverage)
> REFUTATION-FIX (L5-flaw #4, HIGH — coverage mis-stated): `process_operand_with_depth` (`boolean.rs:115-145`) has `_ => Ok(Mesh::new())` and covers ExtrudedAreaSolid/FacetedBrep/TriangulatedFaceSet/SweptDiskSolid/RevolvedAreaSolid/Block/CsgSolid — it does **NOT cover IfcSphere directly** (only via IfcCsgSolid at `csg_primitive.rs:136`) and not Tapered/AdvancedBrep/SectionedSolidHorizontal/SurfaceModel. `mapped.rs:70-108` has Tapered but NOT Block/CsgSolid/Sphere and uses `_ => continue` (`mapped.rs:108`). A bare IfcSphere or Tapered second operand silently becomes `Mesh::new()` → EmptyOperand → uncut host. Fix: unify a `build_operand` covering EVERY solid type reachable as an operand (Tapered, Sphere directly, AdvancedBrep, SectionedSolidHorizontal, SurfaceModel, RevolvedAreaSolidTapered) in BOTH call sites; **gate each on a post-weld watertightness (every edge shared by exactly 2 tris) check BEFORE the kernel** — winding is undefined on non-PWN input, so AdvancedBrep/SurfaceModel/TIN that build open meshes record `BoolFailure(NonWatertightOperand)` and return the un-cut first operand (a NEW correctness regression class the new kernel introduces if unguarded). Correct the prior text: boolean.rs has Block/CsgSolid but NOT Sphere.

### Guard re-derivation table (every `OperandTooLarge`-keyed guard → kernel-native signal)
The new kernel has NO polygon cap (`MAX_CSG_POLYGONS_PER_MESH = 128`, `csg.rs:126`; `has_operand_too_large_since`, `csg.rs:528`), so `capped` is permanently false. But the cap was ALSO an O(1) perf ceiling (see perf section). Native signals: `csg_unchanged` (now a kernel flag, see below), `kernel_failed` (phase errored → un-cut host), `result_engulfed` (passing-cell set empty).

| guard | location | re-derivation |
|---|---|---|
| G1 redundant/capped/engulf precedence | `voids.rs:1525-1526` | `redundant_void \|\| (csg_unchanged && engulfs_host)` — drop `capped`. `redundant_void` = `opening_redundant_with_host` ray-probe (`voids.rs:541`, kernel-independent). |
| G2 #635 AABB fallback (round/hex) | `voids.rs:1453-1545` | Eliminated for the case it protected — the arrangement cuts the real hole (no cap). Verify on #635 fixtures the hole stays round + #964 `bottom_cap_area`. |
| G2′ safety net | — | Record `BoolFailureReason::ArrangementNoOp` when `subtract_mesh` returns host-unchanged AND bounds overlapped AND opening not redundant → a genuine bug still surfaces and is AABB-recoverable (preserves #947). |
| G3 four over-cut guards #553029/#612334/#832/#853 | `extend_opening_along_direction` (`voids.rs:2100-2280`) | UNCHANGED — pure AABB-vs-wall projection, kernel-independent (verified no kernel call). |
| G4 #960 union-then-subtract | `boolean.rs:632-773` | UN-CFG (arrangement provides N-ary). Under-removal guard kept. NOTE the current chain is Manifold-only (`#[cfg(feature="manifold-csg")]` `boolean.rs:632`) — server never ran it — so k-slot equivalence is genuinely UNVERIFIED, gated by G5. |
| G5 `guard_against_full_host_removal` (#821) | `boolean.rs:90-106` | UNCHANGED; `plane_is_coincident_with_host_face` kept. |
| G6 PBHS bounded→unbounded fallback | `boolean.rs:945-972` | **REDERIVE, do not port the heuristic.** See below. |
| G7 `ManifoldOutputDegenerate` retry | `csg.rs:932-962` | DELETE with the second kernel. |
| G8 `OpeningFilterMode` (server-only) | `processor.rs:27` | UNCHANGED — host pre-pass outside the kernel. |

> REFUTATION-FIX (L5-flaw "csg_unchanged tri-count delta", HIGH): `csg_unchanged = csg_result.triangle_count() != tri_before` (`voids.rs:1439-1440`) is a Manifold/BSP-era heuristic. Under the arrangement a CORRECT through-cut can net a zero tri-count delta (remove N, add N boundary tris) → falsely `csg_unchanged=true` → engulf-suppression / AABB fallback → square hole over a correct round one, or uncut wall. Fix: the kernel RETURNS a native `did_modify` flag ("the arrangement inserted a constraint segment / a cell flipped class for this operand"), and `csg_unchanged`/`csg_succeeded` key off THAT, not the tri-count delta.

> REFUTATION-FIX (L5-flaw "G6 ports a kernel-bug detector", HIGH): `difference_result_looks_degenerate` (`csg.rs:1566` → `manifold_result_looks_degenerate` `csg.rs:1517`, marked dead_code without the manifold feature) was tuned to detect a Manifold Linux determinism BUG (`result_tris<4`, `result_tris*4<host_tris`). That bug won't exist in the exact kernel; keeping it FALSELY flags correct small flush-cross-section PBHS cuts (duplex Party Wall #4287/#4399, FZK gable #60012/#67828) as degenerate → drops the polygonal boundary → re-introduces the boundary loss the kernel was meant to fix. Fix: replace with a kernel-native build-time predicate — "the clip polygon spans the full host projected cross-section" (all host side-wall faces lie in/coincident with the prism boundary), detected from the arrangement; only then fall back to the unbounded plane clip. Do NOT port the `result_tris` thresholds.

### BoolFailureReason enum migration (tracked breaking change)
> REFUTATION-FIX (L5-flaw "enum surface break"): `BoolFailureReason` is `#[derive(PartialEq,Eq)]` (`diagnostics.rs:74`), exhaustively `Display`-matched (`diagnostics.rs:127`), string-mapped in `router/mod.rs:579`, asserted on in `router/tests.rs:24,49`. Removing `OperandTooLarge`/`ManifoldOutputDegenerate`/`SolidSolidDifferenceSkipped`/`PolygonalBoundedHalfSpaceFallback` is a compile+test break, not an internal voids.rs change. Migrate in the SAME commit: map removed variants to kernel-native successors (`ArrangementBudgetExceeded`, `NonWatertightOperand`, `ArrangementNoOp`, `KernelPanic`, `CoordinateOutOfRange`), keep a stable string surface for the router overlay, update the exhaustive `Display` and the router tests.

---

## DEPENDENCY PLAN (`rust/geometry/Cargo.toml`)
- ADD: `geometry-predicates = "0.3"` (MIT, no_std, zero deps); promote `num-bigint` (0.4.6), `num-rational` (0.4.2), `num-traits` (0.2.19) from transitive (in `Cargo.lock`) to DIRECT (`default-features=false`).
- KEEP: `i_overlay = "6.0"` (tier-1 only, GATED + fixed-scale per the determinism fix); `earcutr = "0.5"`; `nalgebra = "0.35"`; reuse `rust/clash/src/bvh.rs`.
- REJECT: `robust` (no pub expansion exports); `parry3d`/`-f64` (churn, f32-default, determinism regression, dep weight); `spade` (float crossings — dev-dep cross-check only); `inari` (wasm rounding-mode unsound).
- DELETE (final commit): `manifold-csg` dep (`Cargo.toml:73`), `default=["manifold-csg"]` (`:21`), all manifold features (`:26-30`), cmake/LLVM Docker toolchain, `bsp_csg.rs`, `manifold_kernel.rs`, `mesh_to_polygons`/`polygons_to_mesh`/`consolidate_coplanar`/`merge_coplanar_bucket`/`try_bsp_difference`.
Net wasm-dep change: tiny no_std crate + already-present num-bigint/rational; removes the manifold C++/cxx wasm blocker (this is what newly enables wasm geometry in CI).

---

## DETERMINISM DISCIPLINE (consolidated, the bar is whole-pipeline not just predicate signs)
1. Predicate signs: per-configuration flip table + interval/oracle (L1).
2. Vertex identity: symbolic/exact in core, exact-merge weld at the seam — NEVER float bucket (L3).
3. Fast-path snap: i_overlay fixed-scale or per-platform re-verify (Tier-1).
4. Processing order: canonicalised from exact keys, not float BVH sort (L2).
5. Map iteration: BTreeMap on exact keys; FxHashMap banned from output-reaching iteration (L4, CI grep).
6. Tie-breaks: lexicographically-least exact vertex key for cocircular-square (retriangulate) and coincident-patch radial sort (L4).
7. Orientation: exact tetra-volume sign; reorient global flip resolved to DELETE if L4 fixes orientation (L5).
8. Parallelism: the boolean path is serial today (rayon only in `brep.rs` face triangulation, pre-CSG) — keep the arrangement serial or use order-canonical reduction.

---

## VERIFICATION / MERGE GATE (six layers; flip is the LAST commit, after golden snapshots frozen)
- **G1 — corpus parity** (`tests/kernel_parity.rs`): per (fixture, element, op): bbox (abs 1e-4 m), signed volume (rel 1e-4), NEW native manifoldness (interior edge incident to exactly 2 tris, consistent orientation, on µm-quantised WELDED keys; open shells whitelisted), NEW cut-effectiveness ray-cast (ray through opening centroid exits host even, >0 times). IOS tri counts demoted — see below. Parity = match the BETTER of Manifold/BSP per-op (they disagree: `csg.rs:921` Manifold 1 tri vs aarch64 pentagon).
  > REFUTATION-FIX (L5-flaw "IOS counts are triangulation fingerprints", MEDIUM): `==600/==108/==60/==36` (`door_window_calibration_regression.rs:101,143`) are TRIANGULATION fingerprints of a specific kernel, not kernel-invariant geometry; the Livesu fan yields a different-but-valid count. Fix: **demote the exact IOS counts to SOFT re-blessable snapshots; promote kernel-INVARIANT geometric oracles (volume rel 1e-4, bbox abs 1e-4, native 2-manifoldness, even>0 ray-cast cut-effectiveness) to the HARD gate.** Re-baseline the four counts deliberately when the kernel lands, documenting each new value with a connectivity-fingerprint diff so a real regression stays visible.
- **G2 — cross-platform topology determinism** (NEW CI matrix; biggest gap — `test.yml` is x86_64-only, wasm job `:313` excludes manifold and runs no geometry): `connectivity_hash` (sorted set of sorted-quantised triangle corner triples) + per-target standalone tests for `next_up`/`next_down` bit-identity AND the hand-written indirect LPI/TPI/orient sign manifest. Run across x86_64 / aarch64 (real macos-14 ARM runner) / wasm32-wasip1 (wasmtime); assert byte-identical manifests. **PLUS a ±1-ULP coordinate-perturbation test** (perturb every input coord, assert `connectivity_hash` UNCHANGED) — the only test that catches quantisation/snap/float-sort topology leaks; the same-input-three-platform test can pass while the kernel is still 1-ULP-fragile.
- **G3 — predicate oracle** (`tests/predicate_oracle.rs`): every LPI/TPI `orient3d_i`/`orient2d_i` sign vs num-rational on an adversarial battery (coincident faces, near-coplanar at k·ULP for k∈{0,1,2,16}, collinear, three-plane near-parallel, near-axis-aligned plane) + a "build the SAME LPI from a CW and a CCW host face, assert identical geometric sign" test (catches a missing `sign(d)` flip) + per-configuration `D′` sign table verification. Debug "oracle shadow mode" panics on any tier/stage mismatch.
- **G4 — properties** (proptest): `A−A=∅`, `A∩A=A`, `(A−B)−C ≡ A−(B∪C)`, manifold-in ⇒ manifold-out, `fast_path ≡ forced-arrangement` AND `fast_path(x86)==fast_path(aarch64)==fast_path(wasm)` on every tier-1/tier-2 fixture (except unbounded half-space → boxed-equivalence).
- **G5 — refutation fuzz** (`tests/refutation_fuzz.rs`): never-panic + never-`Err` over FZK gable PBHS #60012/#67828, duplex Party Wall #4287/#4399, #853, #604, #960, #964, self-intersecting malformed cutters; assert guard precedence re-keyed to native signals, snapshot-tested so the swap can't silently drop a guard; no NEW spike triangles (`csg_quality_regression.rs worst_aspect_ratio`). Confirm/add #1007 fixture path.
- **G6 — perf gate** (criterion, `rust/geometry/benches/csg_perf.rs` — **must be BUILT FIRST, see below**).

Two-tier brittleness control: HARD = manifoldness, geometric oracles (volume/bbox/cut-effectiveness), cross-platform connectivity identity (same build → must be identical). SOFT/re-blessable = the IOS counts and the version-evolution connectivity snapshot (a different-but-valid diagonal is allowed). All topology checks on µm-quantised WELDED keys, never raw soup.

---

## PERFORMANCE — HONEST VERDICT + the cap-removal fix
Baselines: server = BSP (`processing/Cargo.toml:20`); viewer = Manifold (`wasm-bindings/Cargo.toml:42`, uncapped C++).
> REFUTATION-FIX (perf-flaw "cap removal = unbounded regression", CRITICAL): on the BSP server a >128-poly operand returns `OperandTooLarge` in O(1) integer comparisons (`csg.rs:489-499`, `cfg(not(manifold-csg))` `:972`) and ships the un-cut host (~0ms). A FacetedBrep/TriangulatedFaceSet cutter of hundreds–thousands of tris is a 0ms no-op TODAY; under a removed cap it becomes a full BVH+tri-tri+re-triangulation+winding pass → 0ms→tens-to-hundreds-of-ms = unbounded slowdown ratio. The proposed post-hoc "intersection-segment budget" fires AFTER the work has started. Fix: **re-derive the cap as a PRE-arrangement operand-complexity budget** — an O(1) early-out before any tri-tri work: if either operand exceeds a tuned polygon/edge budget, return the un-cut host + `BoolFailure(ArrangementBudgetExceeded)` (preserves today's server 0ms behavior). Tune the budget against MEASURED arrangement cost, not BSP's 128.

> REFUTATION-FIX (perf-flaw "coverage double-count" + "#960 net-win unproven" + "no baseline/harness"): (1) coverage measured against the real `subtract_mesh` corpus (M0 instrumentation), not total openings — most rectangular/half-space ops were NEVER on the CSG path, so they are not a cushion. (2) The #960 N-ary collapse re-introduces cutter-vs-cutter coplanar candidate pairs along shared hip/valley seams (the slowest §5.4 path); it is NOT asserted a "net win" — it is gated by an explicit adversarial bench (House.ifc #4148 12+ cutters, AC20-Institute Wand-010 duplicate cutter) proving the single arrangement ≤ N small sequential subtracts. (3) The cited baselines (49/66/648/778ms) and `benches/csg_perf.rs` DO NOT EXIST — build the harness FIRST (M0 prerequisite), capture the Manifold VIEWER wall-clock (currently uncaptured), freeze per-op + total-corpus baselines for BOTH kernels while both are buildable, gate on measured `≤ max(Manifold,BSP)·(1+margin)`.

> REFUTATION-FIX (perf-flaw "IFC saturates exact degeneracies"): IFC is full of EXACT-zero predicates (shared wall faces, coplanar slab boundaries, opening side-walls flush on host faces, axis-aligned coincident cutters) that the interval filter CANNOT certify → escalate to expansion/BigRational, clustered exactly where building geometry is dense. Mitigation: add a deterministic exact-but-CHEAP coplanarity/coincidence fast classifier that resolves the dominant degenerate class without escalating to BigRational, so the ">99% float-resolution" assumption holds on building geometry specifically; quantify the BigRational fire rate on REAL coincident-face fixtures (not synthetic random meshes).

**Honest verdict:** no-regression is NOT yet provable; it is an UNVERIFIED HYPOTHESIS until M0 lands. The two unmitigated-today risks that BLOCK the flip: (a) the cap-removal server regression (mitigated by the pre-arrangement budget above — must be implemented+measured), and (b) the Manifold-viewer dense-brep case (Manifold is optimised C++; the per-op exact arrangement with interval/expansion/rational escalation is per-predicate heavier — this is the HARDEST gate case and the LEAST measured). Per USER DECISION 4 ("treat any design that risks a slowdown as REJECTED unless mitigated"), the flip is blocked until G6 is green on real baselines.

---

## THE FLIP
Reference kernels stay buildable through the window. After all six gates green on all three platforms AND the perf budget+harness measured: ONE commit deletes BSP, Manifold, manifold-csg/-sys, the cmake/LLVM Docker toolchain, every feature flag and `cfg`, the dead helpers, and migrates `BoolFailureReason`. No parallel path, no fallback, no cfg remains.

**Papers:** Cherchi/Livesu/Scateni/Attene 2020 (§4.1,§4.2,§4.3,§5.1–5.4,§5.6) https://www.gianmarcocherchi.com/pdf/mesh_arrangement.pdf • Cherchi/Pellacini/Attene/Livesu 2022 arXiv:2205.14151 (§3,§4,§5) • Zhou/Grinspun/Zorin/Jacobson SIGGRAPH 2016 (§3.1–3.2 Eq.3–7,§5.2–5.5.1) http://www.cs.columbia.edu/cg/mesh-arrangements/ • Attene CAD 2020 arXiv:2105.09772v2 (§2.1–2.2,§4.2–4.6,§5.1–5.2) • Lévy 2024 arXiv:2405.12949 (cross-check). **License-clean toolkit:** geometry-predicates 0.3.0 (MIT), num-bigint/num-rational/num-traits (Cargo.lock), i_overlay/earcutr/nalgebra (Cargo.toml), rust/clash/src/bvh.rs (reuse). Attene Indirect_Predicates + CinoLib/EMBER (C++/LGPL) = MATH ONLY, never copied.


---

## M1 — predicate foundation (start-now detail)

## M1 — Predicate Foundation (start-now spec)

M1 delivers a standalone, fully-tested `rust/geometry/src/kernel/` predicate layer with NO arrangement, NO IFC seam. Exit = G3 (predicate oracle) + the L1 slice of G2 (cross-platform indirect sign manifest) green on x86_64/aarch64/wasm.

### Modules
- `kernel/mod.rs` — re-exports.
- `kernel/predicates.rs` — public `orient3d`, `orient2d` dispatching on `ImplicitPoint` arg configuration.
- `kernel/indirect.rs` — `Lpi`, `Tpi` constructors + λ-construction + the per-configuration sign table.
- `kernel/interval.rs` — `RnInterval` directed-rounding interval.
- `kernel/rational.rs` — BigRational exact oracle (num-rational).
- `kernel/expansions.rs` — thin re-export of geometry-predicates `two_sum`/`two_product`/`split`/`scale_expansion_zeroelim`.

### Types
```rust
pub enum ImplicitPoint { Explicit([f64;3]), Lpi(Lpi), Tpi(Tpi) }
pub struct Lpi { pub p:[f64;3], pub q:[f64;3], pub r:[f64;3], pub s:[f64;3], pub t:[f64;3] }
pub struct Tpi { pub planes:[[[f64;3];3];3] }
#[derive(Clone, Copy, PartialEq, Eq)] pub enum Sign { Negative, Zero, Positive }
pub struct LambdaExpl { pub lx:Vec<f64>, pub ly:Vec<f64>, pub lz:Vec<f64>, pub d:Vec<f64> } // expansions
pub struct LambdaIvl  { pub lx:RnInterval, pub ly:RnInterval, pub lz:RnInterval, pub d:RnInterval }
pub struct RnInterval { pub lo:f64, pub hi:f64 } // [lo,hi], outward-rounded
```

### Signatures
```rust
// Public dispatch — picks EEE/IEE/IIE/III by counting implicit args.
pub fn orient3d(a:&ImplicitPoint, b:&ImplicitPoint, c:&ImplicitPoint, d:&ImplicitPoint) -> Sign;
pub fn orient2d(a:&ImplicitPoint, b:&ImplicitPoint, c:&ImplicitPoint, axis:DropAxis) -> Sign;

// λ-construction (the only place λ is built; cached on the ImplicitPoint).
fn lpi_lambda_interval(l:&Lpi) -> Option<LambdaIvl>;   // None iff d straddles 0 in interval (escalate)
fn lpi_lambda_expansion(l:&Lpi) -> LambdaExpl;          // exact expansions
fn lpi_lambda_rational(l:&Lpi) -> (BigRational,BigRational,BigRational,BigRational); // λx,λy,λz,d
// TPI analogues.

// Per-configuration sign assembly. `den_signs` = signs of the odd-multiplicity denominators ONLY.
fn assemble_sign(lambda_det_sign:Sign, den_signs:&[Sign]) -> Sign;

// Interval primitives (every op widens outward).
impl RnInterval {
    fn add(self, o:Self)->Self; fn sub(self, o:Self)->Self; fn mul(self, o:Self)->Self;
    fn contains_zero(&self)->bool; // straddle ⇒ escalate
}
fn next_up(x:f64)->f64;   // integer bit-twiddle, NOT f64::next_up
fn next_down(x:f64)->f64;
```

### The per-configuration sign table (CONST, verified by G3)
```
orient2d, 1 implicit (1I): D' = d (odd)    -> flip on sign(d)   [SHIPPED pre-scaled-λ convention; code is ground truth, NOT Attene's raw-λ d^2/no-flip]
orient2d, 3 implicit (3I): D' = d1^2 d2 d3 -> flip on sign(d2)*sign(d3)
orient3d, 1 implicit (1I, LPI): D' = d     -> flip on sign(d)            <-- the hot case
orient3d, 3 implicit (3I, TPI): D' = (d1 d2 d3 d4)^2 -> NO flip
mixed: product of the above; flip = parity over the ODD-multiplicity denominators only
```
`assemble_sign(lambda_det_sign, den_signs)`: result = `lambda_det_sign` XOR (parity of `Negative` entries in `den_signs`), where `den_signs` lists ONLY odd-power denominators per the table. Squared denominators NEVER enter `den_signs`.

### LPI-orient3d worked construction (the critical hot path, with the flip)
Goal: sign of `orient3d(p1, p2, p3, p4)` where `p1` is an LPI implicit point `(λx/d, λy/d, λz/d)` and `p2,p3,p4` are explicit.
1. Build λ exactly (or interval/expansion per tier): `qp=Q−P; sr=S−R; tr=T−R; pr=P−R; d=det3(qp,sr,tr); n=det3(pr,sr,tr); λx=d·Px+n·(Qx−Px)` (and y,z).
2. Homogenise the determinant. The naive `orient3d` is `det3(p1−p4, p2−p4, p3−p4)`. With `p1=(λ/d)` and `p2,p3,p4` explicit, multiply row 1 by `d` (clears the denominator), giving the polynomial
   `Λ′ = det3( (λx − d·p4x, λy − d·p4y, λz − d·p4z), (p2−p4), (p3−p4) )`.
   This is an exact polynomial in the input coordinates — evaluate it by the 3-stage cascade.
3. **Apply the flip.** Multiplying row 1 by `d` scales the determinant by `d` (degree 1, ODD): the geometric sign is `sign(Λ′)` only if `d>0`; if `d<0` the sign is INVERTED. So `orient3d_lpi = assemble_sign(sign(Λ′), &[sign(d)])`. For `p1=p2=`LPI (2 implicit) the row scaling is `d1·d2` (parity over both); for TPI (the III case) the product is a perfect square → `den_signs` empty → no flip. Test: build the SAME LPI from a CW and a CCW orientation of the host face `RST` (which flips `sign(d)`); `assemble_sign` must return the IDENTICAL geometric sign both ways.

### 3-stage (4-stage incl. explicit) evaluation cascade
```
fn orient3d_indirect(...) -> Sign {
  // stage 0: semi-static filter on the Λ' polynomial (purpose-built bound, NOT o3derrbound).
  if let Some(s) = static_filter_lambda_det(...) { return assemble_sign(s, den_signs); }
  // stage 1: interval (cached λ intervals).
  if let Some(li) = lambda_interval_cached(...) {
     let det = lambda_det_interval(li, ...);
     if !det.contains_zero() { return assemble_sign(det.sign(), den_signs); }
  }
  // stage 2: expansion.
  let det = lambda_det_expansion(...);
  if det.sign() != Zero { return assemble_sign(det.sign(), den_signs); }
  // stage 3: BigRational oracle.
  assemble_sign(lambda_det_rational(...).sign(), den_signs)
}
```
Explicit-only args bypass to `geometry_predicates::orient3d(...).signum()`. Cache `LambdaIvl` and the stage-0 bound on the `ImplicitPoint` (compute once, reuse across ~k predicate calls per vertex).

### Interval soundness construction
- `add/sub`: round-to-nearest then `lo=next_down(lo); hi=next_up(hi)`.
- `mul`: 4 endpoint products `[lo·lo, lo·hi, hi·lo, hi·hi]`; `lo=next_down(min); hi=next_up(max)`; zero-straddle handled by the min/max over all four (no special branch needed if all four corners taken). Property test: interval ALWAYS brackets BigRational across the fuzz battery on all 3 targets.
- `next_up`/`next_down`: bit-twiddle (`f64::to_bits`/`from_bits`, ±1 on the mantissa with sign handling), standalone G2 bit-identity test across targets.

### Coordinate-window guard
Before constructing any λ, assert all input coords are within the computed safe exponent budget (TPI `Λ′` ≤ ~coord⁶). Out of range → return `Sign` via a `Result`/sentinel that the caller routes to `BoolFailure(CoordinateOutOfRange)`. NEVER clamp.

### Test matrix (G3 + L1 slice of G2)
1. **Per-configuration sign table:** for each of {orient2d-1I, orient2d-3I, orient3d-1I/LPI, orient3d-3I/TPI, mixed IEE/IIE}, random + adversarial inputs, assert `assemble_sign` == BigRational recompute. Specifically catches the multiplicity bug.
2. **CW/CCW same-point:** build the same LPI/TPI from oppositely-wound defining faces; assert identical geometric sign (catches a missing/extra flip).
3. **Adversarial battery:** coincident faces; near-coplanar at k·ULP for k∈{0,1,2,16}; collinear points; three near-parallel planes; near-axis-aligned plane (for the orient2d projection-axis fall-through).
4. **Projection-axis:** assert the chosen axis yields a nonzero exact projected determinant; on a constructed degenerate first candidate, assert fall-through to the next axis.
5. **Interval brackets oracle:** property test over the fuzz battery, all 3 targets.
6. **`next_up`/`next_down` bit-identity:** standalone, x86_64/aarch64/wasm.
7. **Indirect sign manifest (G2 slice):** run the full LPI/TPI/orient battery, hash the SIGN vector, assert byte-identical across the 3 targets — this is the determinism-bar proof for L1 and must be green before M2 starts.
8. **FMA grep:** `rg 'mul_add|\.fma\('` over `kernel/` empty.
9. **Shadow mode:** debug build panics if any stage disagrees with stage-3 rational.

### M1 exit criteria
- G3 oracle green (all 9 matrix items).
- The G2 L1-slice (indirect sign manifest + next_up/next_down bit-identity) green on x86_64 + aarch64 (real ARM runner) + wasm32-wasip1 (wasmtime).
- `geometry-predicates` added; `num-bigint`/`num-rational`/`num-traits` promoted to direct.
- No `mul_add`/`fma` in `kernel/`.


---

## Perf verdict (HARD GATE — currently UNVERIFIED)

Honest verdict: no-regression is NOT yet provable — it is an UNVERIFIED HYPOTHESIS, and per USER DECISION 4 ("treat any design that risks a slowdown as REJECTED unless mitigated") the flip is BLOCKED until the perf harness exists and the budget is measured. Two unmitigated-today risks: (1) CRITICAL cap-removal server regression — on the BSP server a >128-poly operand returns OperandTooLarge in O(1) and ships the un-cut host (~0ms, csg.rs:489-499/972); removing the cap turns a 0ms no-op on a several-hundred/thousand-tri FacetedBrep/TriangulatedFaceSet cutter into a full arrangement (0ms→tens-to-hundreds-of-ms, an unbounded ratio). MITIGATION (required, not optional): re-derive the cap as a PRE-arrangement O(1) operand-complexity budget that returns the un-cut host + BoolFailure(ArrangementBudgetExceeded) BEFORE any tri-tri work — NOT the draft's post-hoc intersection-segment budget which fires after the cost is incurred. Tune the budget against measured arrangement cost, not BSP's 128. (2) HIGH Manifold-viewer dense-brep case — Manifold is optimised, uncapped C++ (wasm-bindings/Cargo.toml:42); the per-op exact arrangement with interval+expansion+rational escalation is per-predicate heavier, and IFC geometry SATURATES exact-zero degeneracies (shared wall faces, coplanar slabs, flush opening side-walls, axis-aligned coincident cutters) that the interval filter cannot certify and that escalate toward BigRational — clustered exactly where geometry is dense. This is the hardest gate case and the least measured. Mitigations: a cheap exact coplanarity/coincidence fast classifier that resolves the dominant degenerate class without BigRational; the stage-0 semi-static filter the draft wrongly dropped (the refutation restored it — forcing all indirect calls through interval arithmetic was a self-inflicted regression against the gate); λ-interval caching; ≥95% fast-path coverage measured against the REAL subtract_mesh corpus (NOT total openings — the ~86% rectangular figure double-counts ops that were AABB box clips and NEVER on the CSG path, voids.rs:1349). Three claims that must be fixed before any "not slower" assertion: the cited baselines (49/66/648/778ms) and benches/csg_perf.rs DO NOT EXIST — build the harness FIRST and capture the uncaptured Manifold viewer wall-clock; the #960 N-ary collapse is NOT a proven net win (it re-introduces cutter-vs-cutter coplanar pairs along shared seams through the slowest §5.4 path) and must be benched against N small sequential subtracts; and the >99%-float-resolution claim must be measured on real coincident-face fixtures, not synthetic meshes. Gate (criterion): per-op new-kernel ≤ max(Manifold,BSP)·(1+margin) AND total-corpus ≤ reference, captured pre-flip while both reference kernels are buildable, plus explicit dense-adversarial benches (two interpenetrating tessellated breps with O(n²) shared-face contact; a host with hundreds of NonRectangular openings; a 12+-cutter chain with duplicate/coplanar cutters — House.ifc #4148, AC20-Institute Wand-010).


## Critical risks

- CRITICAL — wrong indirect sign flip silently inverts inside/outside for ~half of real cuts. The draft's blanket 'XOR parity over all negative denominators' rule is WRONG: it ignores per-term denominator MULTIPLICITY. orient3d-1I/LPI has D'=d (odd → MUST flip on sign(d)); orient3d-3I/TPI has D'=(d1d2d3d4)² (square → NO flip); orient2d-3I has D'=d1²d2d3 (flip on d2,d3 only). The implementation sketch ENCODED the bug. Mitigation: per-(predicate,configuration) const sign table + G3 oracle vs BigRational + the CW/CCW-same-point test + shadow mode. Invisible to tri-count tests.
- CRITICAL — float-quantised vertex weld converts allowed 1-ULP coordinate drift into FATAL topology divergence. weld_vertices (manifold_kernel.rs:41-43, (v*1e6).round()) buckets a half-cell-straddling vertex to different integers across platforms → different vertex identity → different adjacency → different topology, re-introduced AFTER the exact core finishes. Reproduced. Mitigation: symbolic/exact vertex identity inside L3/L4 (never rounded coords); exact-predicate snap-merge at the seam weld with lexicographically-least exact merge target; a ±1-ULP coordinate-perturbation G2 test that the same-input-three-platform test cannot catch.
- CRITICAL — a Rust panic in the heavier kernel (BigRational division, three-stage escalation, re-triangulation index walks, radial sort) unwinds THROUGH the match Ok/Err at voids.rs:1427 and aborts the server process / crashes the wasm worker — strictly worse than today's un-cut host, silently downgrading the frozen never-Err contract to never-Err-but-can-panic. Mitigation: catch_unwind boundary inside each of the four seam ops on native (→ BoolFailure(KernelPanic)+un-cut host); panic-free-by-construction on wasm (checked indexing, exhaustive d==0 refusal, no unwrap/[i]//d on the hot path) proven by a CI no-panic fuzz.
- CRITICAL — cap-removal is an unbounded server perf regression (0ms→full arrangement) on large Brep cutters the 128-poly cap (csg.rs:489-499) refuses in O(1) today. Mitigation: a PRE-arrangement O(1) operand-complexity budget returning the un-cut host + BoolFailure BEFORE any tri-tri work, NOT a post-hoc intersection-segment budget; tuned against measured arrangement cost. Blocks the flip until measured.
- HIGH — G2 (cross-platform topology determinism) does not exist (test.yml is x86_64-only; the wasm job at :313 excludes manifold and runs no geometry), so the determinism bar — the design's central premise — is UNVERIFIED, and the FMA-clean proof covers only the geometry-predicates LIBRARY, not the hand-written indirect λ/det layer where the risk lives. Mitigation: stand up the x86_64/aarch64(real ARM runner)/wasm32-wasip1 matrix as a PREREQUISITE, run it on the hand-written indirect signs specifically, plus the ±1-ULP perturbation test and next_up/next_down bit-identity test. The pure-Rust kernel removes the manifold-cxx wasm blocker that forced today's exclusion.
- HIGH — non-determinism in the BULK fast path: tier-1 i_overlay's float→int snap is bounding-box-dependent (FloatPointAdapter dir_scale=exp2(29−log2(max_half_extent)), then .to_i32()), so a 1-ULP drift can flip dir_scale across a log2 boundary or push an endpoint across a grid line → different hole topology — on the >majority of window/door cuts. The draft's consistency check only compares fast-vs-arrangement on ONE platform. Mitigation: quantise to the seam grid with exact rounding before i_overlay and use with_scale/with_offset (fixed, not new()); extend G4 to assert fast_path(x86)==fast_path(aarch64)==fast_path(wasm); else demote tier-1 to speed-only / fall to the arrangement and re-argue perf.
- HIGH — clip_mesh / IfcHalfSpaceSolid cannot be expressed in the winding kernel and breaks the 'single kernel' framing: clip_mesh produces OPEN meshes (chained twice at layers.rs:489-501, kept as open SubMesh) and an unbounded half-space (boolean.rs:150-244) has no closed cutter, so winding classification and the force_arrangement() consistency obligation are undefined for the single most common clip operand. Mitigation: declare two internal kernels (arrangement + exact half-space clip); gate the half-space by the G3 predicate oracle + a boxed-equivalence test (close into a finite cutter box > host AABB, compare to arrangement subtract), not the fast-path≡arrangement fingerprint; forbid feeding clip_mesh output into a winding-classified op.
- HIGH — porting Manifold/BSP-era heuristics as if they were correctness invariants: (a) csg_unchanged = tri-count delta (voids.rs:1439) misclassifies a correct net-zero-delta arrangement cut as a failure → square hole / uncut wall — replace with a kernel-native did_modify flag; (b) G6 difference_result_looks_degenerate (csg.rs:1517, a Manifold Linux determinism-BUG detector) falsely flags correct small flush-cross-section PBHS cuts → drops the polygonal boundary — replace with a kernel-native full-cross-section-span predicate; (c) the exact IOS tri counts (==600/==108/==60/==36) are triangulation fingerprints, not kernel-invariants, and will fail benignly under the Livesu fan — demote to SOFT snapshots and promote volume/bbox/manifoldness/cut-effectiveness to the HARD gate.
- MEDIUM — silent geometry loss and a NEW PWN-undefined regression class from operand-builder gaps: boolean.rs:144 (_ => Ok(Mesh::new())) drops IfcSphere (only reachable via IfcCsgSolid), Tapered, AdvancedBrep, SectionedSolidHorizontal, SurfaceModel; mapped.rs:108 (_ => continue) drops Block/CsgSolid/Sphere; and open-mesh operands (AdvancedBrep/SurfaceModel/TIN) give UNDEFINED winding under the new kernel. Mitigation: unify build_operand across all solid types in both sites; gate each on a post-weld watertightness (2-manifold edge) check → BoolFailure(NonWatertightOperand)+un-cut first operand on non-PWN input.
- MEDIUM — reorient_outward's whole-shell signed-volume flip is a naked f64 sum (manifold_kernel.rs:293-326) that can flip orientation differently across platforms on near-zero-volume/symmetric operands → silent boolean inversion (House.ifc #3448 class), and applying weld+reorient universally changes the server's previously-unconditioned BSP pipeline that the IOS baselines were calibrated on. Mitigation: exact tetra-volume sign; lexicographically-least exact BFS seed (not component[0] from an FxHashMap); resolve the open decision to DELETE the global flip if L4 fixes orientation; re-baseline the server outputs after adding weld+reorient but BEFORE swapping the kernel so the two changes are bisectable.

## Milestones

- **M0** — Perf + determinism harness and baselines as a PREREQUISITE (the draft's 'open: must measure' items are merge prerequisites, not residual risks). Build rust/geometry/benches/csg_perf.rs (criterion); capture the uncaptured Manifold VIEWER wall-clock per model; instrument the current pipeline to count ops actually reaching subtract_mesh/clip_mesh (NOT total openings) and classify tier-1/2/3 coverage against that real corpus; stand up the x86_64/aarch64(real ARM runner)/wasm32-wasip1 CI matrix with a connectivity_hash. Freeze per-op + total-corpus baselines for BOTH BSP and Manifold while both are buildable.
  - *exit:* benches/csg_perf.rs runs in CI; frozen baselines committed for both reference kernels on all 3 platforms; Manifold viewer wall-clock captured; real subtract_mesh coverage fraction measured and reported; the 3-platform CI matrix is green on the existing kernels (proving the harness itself is deterministic before the new kernel exists).
- **M1** — Predicate foundation: kernel/{predicates,indirect,interval,rational,expansions}.rs. Per-configuration sign table (EEE/IEE/IIE/III), LPI/TPI λ-construction, 4-stage cascade (explicit → stage-0 semi-static filter on Λ' → interval → expansion → BigRational), directed-rounding RnInterval, assert-not-clamp coordinate-window guard. Add geometry-predicates; promote num-bigint/num-rational/num-traits to direct.
  - *exit:* G3 predicate oracle green (per-config sign table vs BigRational, CW/CCW-same-point, adversarial k·ULP battery, projection-axis fall-through, interval-brackets-oracle, shadow mode); G2 L1-slice green (indirect SIGN manifest byte-identical + next_up/next_down bit-identical across x86_64/aarch64/wasm); FMA grep empty over kernel/.
- **M2** — Geometry kernel: f64 BVH broadphase (lift rust/clash/src/bvh.rs) with EXACT-key canonical pair ordering; exact Guigue-Devillers tri-tri (explicit points); Livesu O(n) constrained re-triangulation over mixed explicit+implicit points via orient2d_i, fed points in canonical exact order, with the lexicographically-least-exact-vertex tie-break for cocircular/collinear cases.
  - *exit:* broadphase pair-set determinism hash identical across 3 targets (criterion bench hand-rolled vs parry3d-f64 settling the BVH decision); re-triangulation output topology-invariant to insertion order (property test) and identical across 3 targets on the adversarial in-plane battery.
- **M3** — Arrangement L3: Phase 2 intersection detection (LPI per crossing), Phase 3 point insertion (split-before-edges, indirect point-in-triangle), Phase 4 segment insertion (addSegment, TPI for seg-seg concurrence, §5.4 coplanar path). Vertex identity is symbolic/exact throughout — NO float bucket.
  - *exit:* output is one conforming intersection-free complex on the corpus; every sub-tri references its input tri/operand tag; ±1-ULP coordinate-perturbation test leaves connectivity_hash UNCHANGED; cross-platform connectivity identity on the arrangement-eligible corpus.
- **M4** — Classification L4 (Zhou-2016 winding-vector): patches, exact-orient3d radial sort with the exact canonical secondary key for coincident/coplanar patches, BTreeMap-only graphs (FxHashMap iteration banned from output via CI grep), BFS winding propagation, f(w) extraction, single implicit→float at Phase 8. The four ops + N-ary subtract as predicates on w.
  - *exit:* A−A=∅, A∩A=A, (A−B)−C ≡ A−(B∪C), manifold-in⇒manifold-out (proptest); #964 double-encoded-void and #960 seam fixtures produce identical cell-patch graph + f(w) cross-arch; #960 falls out under k separate slots (the draft's open question resolved by test, no pre-union needed).
- **M5** — Fast-path dispatch + consistency: tier-1 2D-reextrude with FIXED-scale i_overlay (exact pre-quantise, with_scale not new()); tier-2 exact orient3d half-space clip (kernel B) replacing clip_triangle; internal runtime dispatcher mirroring the router classifier; force_arrangement() test flag.
  - *exit:* G4 green: fast_path ≡ forced-arrangement on every tier-1/tier-2 fixture AND fast_path(x86)==fast_path(aarch64)==fast_path(wasm); half-space gated by boxed-equivalence + G3 (no force_arrangement for unbounded operands); tier-1 proven not slower than the box clip it replaces on the rectangular-through class.
- **M6** — IFC seam L5: catch_unwind (native) / panic-free-by-construction (wasm) around the four ops; exact-merge weld + exact-tetra-volume reorient (or DELETE the global flip if L4 fixes orientation); unified build_operand across all solid types with post-weld watertightness gating; kernel-native did_modify replacing the tri-count csg_unchanged; G6 rederived as a full-cross-section-span predicate; pre-arrangement O(1) operand-complexity budget (the cap re-derivation); BoolFailureReason enum migration (router/mod.rs:579 + router/tests.rs updated in the same commit).
  - *exit:* G5 refutation fuzz green (never-panic + never-Err over FZK PBHS #60012/#67828, duplex #4287/#4399, #853, #604, #960, #964, malformed cutters; guard precedence snapshot-tested on native signals; no new spike triangles); operand watertightness gating verified; the pre-arrangement budget preserves the server's 0ms behavior on >budget Brep cutters.
- **M7** — Verify gate + the flip. Run G1 (corpus parity: volume/bbox/native-manifoldness/cut-effectiveness HARD; IOS counts SOFT re-blessed) + G2 (full cross-platform topology determinism incl. ±1-ULP) + G6 (perf gate ≤ max(Manifold,BSP)·(1+margin) per-op AND total-corpus, incl. dense-adversarial benches). Then ONE flip commit.
  - *exit:* all six gates green on all 3 platforms; perf budget MET on the dense-brep/MEP/12+-cutter adversarial benches; flip commit deletes BSP, Manifold, manifold-csg/-sys, cmake/LLVM Docker toolchain, every feature flag and cfg, the dead helpers, and completes the enum migration — no parallel path, no fallback, no cfg remains.

## Open decisions (maintainer)

- reorient_outward global flip: DELETE or KEEP? Resolve to DELETE if L4 winding classification already fixes global orientation (every retained float orientation decision at the seam is a determinism liability). Needs a maintainer call after M4 proves L4 orientation is self-sufficient on open/non-manifold shells (the 24 T-junction FZK case) — if L4 cannot, keep reorient but with the exact tetra-volume sign + lexicographically-least exact BFS seed.
- Pre-arrangement operand-complexity budget threshold: what polygon/edge count triggers the O(1) un-cut-host early-out? Must be TUNED against measured arrangement cost (M0/M6), not inherited from BSP's 128. Trade-off: too low re-introduces #635-class round-hole loss the arrangement was meant to fix; too high re-opens the server 0ms→full-arrangement regression. Maintainer sets the margin after M0 baselines.
- Perf gate margin: what (1+margin) per-op slowdown is acceptable, and is total-corpus-≤-reference a hard requirement or a budgeted-tradeoff against the wasm-geometry-enablement win? The Manifold-viewer dense-brep case may not beat optimised C++ per-op; decide whether a small per-op regression there is acceptable given the kernel newly enables wasm geometry execution (which Manifold's cxx-shim blocked entirely).
- i_overlay tier-1 determinism: can the FloatPointAdapter be pinned to a fixed scale/offset (with_scale) that is provably cross-arch-stable, or must tier-1 be demoted to speed-only / dropped to the arrangement? If dropped, the >majority window/door-cut perf argument must be re-run. Decide after M5 measures fixed-scale i_overlay cross-platform connectivity.
- subtract_meshes_batched (csg.rs:1429, threshold 10): collapse into one N-ary arrangement pass (perf win, but trades per-void failure granularity for per-batch) or keep per-void? Affects how a single bad void in a batch surfaces in BoolFailure diagnostics.
- #960 pre-union of cutters: confirmed unnecessary if M4 shows k separate winding slots dissolve the seam slivers — but if classification re-introduces an edge case at shared hip/valley seams (the §5.4 coplanar path the draft flags), a maintainer decides whether to pre-union cutters (perf cost) or accept per-slot (correctness-clean). Resolve by the M4 #960 fixture result.
- BoolFailureReason variant naming for the migration (ArrangementBudgetExceeded / NonWatertightOperand / ArrangementNoOp / KernelPanic / CoordinateOutOfRange): these strings surface in the viewer overlay (router/mod.rs:579) — maintainer confirms the user-facing wording and whether any removed variant needs a back-compat alias for serialized diagnostics consumers outside the repo.
- #1007 fixture: confirm the path/existence for G5 (the draft listed it as to-be-verified). If it does not exist, maintainer decides whether to author it or drop it from the hard-required refutation-fuzz set.

---

## M0 measurements (captured 2026-06-08)

### CSG op census — the real heavy-path workload
Instrumented at the 4 kernel entry points (`csg.rs` `record_csg_op`); measured over 16 real-world
fixtures (FZK-Haus, duplex, dental, C20, advanced_model, schependomlaan, FM_ARC, ISSUE steel/school/infra,
Roof-01_BCAD) = **1323 kernel ops** (1082 subtract + 241 clip + 0 union/intersection).

Operand max-triangle distribution:

| ≤12 | 13–32 | 33–128 | 129–512 | 513+ |
|---|---|---|---|---|
| 31.0% | 38.2% | 16.2% | 9.3% | 5.4% |

- **~85% of ops have ≤128-tri operands** → fast-path / cheap-arrangement territory (no-regression thesis holds for the bulk).
- **Heavy tail is real but bounded: 14.7% >128 tris, worst case 3636 tris** — concentrated in steel/school/tower models (ARK 451 ops, ISSUE_129 215, advanced_model 168). This is the perf-gate risk + the server cap-removal exposure (194 ops BSP refuses in O(1) today → square holes — the arrangement would actually cut them).
- **Corpus is difference+clip-dominated; 0 union/intersection** across these fixtures → the kernel's priority paths are DIFFERENCE and HALF-SPACE CLIP; union/intersection are rare `IfcBooleanResult` cases (need the #960 segmented-roof + steel-union fixtures to exercise).

Implication for the perf gate: the `pre-arrangement O(1) operand-complexity budget` threshold (open decision) is the lever for the 194 heavy ops; the question is the per-op arrangement cost at 128…3636 tris vs Manifold — answered by the timing baseline below.

### Timing baseline — subtract_mesh, box-through-slab (low intersection)
`examples/csg_timing.rs`, native aarch64, subdivided-box operands at the census buckets:

| host/cutter tris | BSP µs/op | Manifold µs/op | Manifold result tris |
|---|---|---|---|
| 12 / 12 | 70 | 76 | 32 |
| 192 / 48 | 80 | 272 | 224 |
| 432 / 192 | 122 | 569 | 480 |
| 768 / 432 | 186 | 1091 | 800 |
| 1728 / 768 | 323 | 2122 | 1776 |
| 3888 / 1728 | 708 | **4778** | 4096 |

- **BSP returns a constant 24-tri result at every size** — fast because it's producing collapsed/wrong geometry (the coplanar-merge + cap path). NOT a meaningful correctness baseline.
- **Manifold is the correctness baseline**: ~linear, **~4.8 ms on the worst 3888-tri op**. The new kernel's per-op budget = ≤ Manifold; with the heavy tail at 5.4% of ops and ~5 ms each, there is real headroom.
- CAVEAT: these are LOW-intersection (a box punching through a slab). The DENSE-intersection worst case (two interpenetrating faceted Breps, O(n²) tri-tri contact — the refutation's #1 perf risk) is a remaining M0 measurement; capture Manifold's dense-case time before M7 so the new kernel's arrangement has a real budget on that class.

### M0 verdict
No-regression is now PLAUSIBLE, not proven: the 85% small-operand bulk is cheap in both kernels; the heavy tail is bounded (worst 3636 tris ≈ 5 ms Manifold) and rare (5.4%). The two open perf items: (1) measure the dense-intersection baseline; (2) tune the pre-arrangement operand-complexity budget against these numbers (the server's BSP "0 ms but wrong" on heavy ops is not a baseline to preserve — correctness wins, budget caps the cost). Full no-regression proof lands at M7 when the kernel exists and runs the same harness.


---

# M2.3 — In-plane constrained re-triangulation (hardened design)

> From the M2.3 design-hardening pass (9 agents). New predicates + 9 sub-increments (M2.3.0–M2.3.8); the predicate layer (2I/3I orient2d + cmp_lex + G2 manifest) gates BEFORE any topology output.

# M2.3 — In-Plane Constrained Re-Triangulation: Implementation-Ready Spec

**Module:** `rust/geometry/src/kernel/retriangulate.rs` (new). **Milestone:** M2/L2→L3 (design doc `docs/architecture/pure-rust-csg-kernel.md:390-391`, `:99-103`). **Input:** per intersected input triangle `T`, the in-plane intersection sub-segments produced by `tritri::tri_tri_intersection` (`TriTri::Segment([Lpi;2])`, `tritri.rs:120-121`) plus the points those segments and `T`'s own corners contribute. **Output:** a conforming, intersection-free fan of sub-triangles over `T`, vertices referenced **symbolically** (never a float coordinate), **topology invariant to insertion order and byte-identical across x86_64/aarch64/wasm**. This is the conforming-mesh step L3 glues into one complex and L4 winding-classifies.

Algorithm = **Cherchi/Livesu/Scateni/Attene 2020** *Fast and Robust Mesh Arrangements* (SIGGRAPH Asia 2020) §5.2–5.3 per-triangle refinement (point-split then segment-insert), pocket fill via **Livesu/Cherchi/Scateni/Attene** *Deterministic Linear Time Constrained Triangulation using Simplified Earcut* (IEEE TVCG 28(12) 2022, arXiv:2009.04294) §4 Alg.1 / §5.1–5.4. It is **not a Delaunay CDT**: only `orient2d` is used, **no incircle/insphere** (Simplified Earcut §6: triangulations "do not necessarily have the Delaunay property"). **Order-independence + cross-platform determinism is an ifc-lite-engineered layer on top — the papers guarantee linear *time* only, not output uniqueness** (Simplified Earcut §4 "extract one ear from E" is unordered; the reference inserts in raw input order with LIFO stacks). Every load-bearing addition below exists to discharge that gap.

---

## 0. Decisions where the facets/refutations conflict — resolved

**D1. BOTH doc sign-tables are WRONG for `orient2d 1I`; the shipped kernel is RIGHT — and the *reason* must be recorded or it gets re-broken.** Doc `pure-rust-csg-kernel.md:54` (primary markdown table) AND `:303` (code-block table) both state `orient2d 1I: D'=d² → NO flip`. The shipped code `rational.rs:199-207` (`indirect_orient2d`) and its interval twin `interval.rs:209-225` use `den_signs=[sign(d)]` — a **d¹ ODD flip**. The kernel is geometrically correct, verified two independent ways: (i) the shipped oracle test `indirect_orient2d_matches_materialised_point` (`predicates.rs:318-338`) passes — homogenised orient2d == direct orient2d on the exact materialised λ/d point for every axis; (ii) the plane-rewind invariance: rewinding the defining plane flips `sign(d)` while leaving the materialised point + 2D query geometrically identical, so the TRUE sign is unchanged — the kernel's d¹-flip preserves it, the doc's d²-no-flip inverts it. **Root cause:** the kernel's λ is **pre-scaled by one factor of d** (`rational.rs:96`: `lx = d·P − n·(Q−P)`), so the projected numerator `Λ'₂` is degree-1 (odd) in d. Attene's `D'=d²` is correct only for his **raw-Cramer-λ** convention (Attene 2020 §4.3), which the kernel does *not* use. **Actions:** (a) correct **both** doc rows `:54` and `:303` to `orient2d 1I: D'=d (odd) → flip on sign(d)`; (b) add the inline note: *"shipped code (`rational.rs:206`) is ground truth (pre-scales λ by d — NON-Attene convention); do NOT copy Attene's published `D'` rows for 2I/3I without dividing out the pre-scale — derive the flip from the verified joint-homogeneity property below; regression-guarded by `indirect_orient2d_matches_materialised_point` (`predicates.rs:318`)"*; (c) **do NOT change the code**; (d) add the missing **orient2d** plane-winding-invariance regression test (orient3d has it at `predicates.rs:137,258`; orient2d does not). A future implementer following the doc table would invert point-location over every LPI/TPI vertex whose construction gives `d<0` (≈half of host faces) — **risk #1**.

**D2. Canonical pre-sort + min-VID ear tie-break, NOT raw LIFO.** The reference is order-sensitive (verified: arXiv:2009.04294 §4–5). Adopt: (a) a global symbolic VID per arrangement vertex (D3); (b) point insertion in **lex-rank** order; (c) segments processed in `(min-rank, max-rank)` order; (d) the otherwise-unspecified "extract one ear" pinned to **least apex lex-rank**. This is the only way requirement (d) holds.

**D3. VID is GLOBAL across the operand (per-arrangement), assigned + owned by L3 — NOT per-T.** Two adjacent input triangles share an intersection segment whose endpoints are the *same* LPI construction; for the two re-triangulated surfaces to *conform* (the entire point of M2.3) that point must get the **same** VID in both. M2.3 therefore consumes a **global** symbolic interner (L3-owned, read-mostly), and mints any new Phase-D TPI into it. Per-T-local VIDs would pick mismatched diagonals along the shared seam → non-conforming. Reject per-T-local.

**D4. Vid (stable id) is DECOUPLED from lex-rank (computed by `cmp_lex`).** A facet caught the draft's contradiction ("Vid IS the lex rank" + "intern mints new mid-algorithm Vids"). Inserting a new TPI mid-algorithm (Phase D) would shift every later rank if Vid==rank, breaking the "plain integer sort" shortcut. **Resolution:** `Vid(u32)` = stable insertion-order id (append-only). **Lex-rank** is a separate `Vid→u32` index recomputed (or incrementally maintained) by `cmp_lex` at sort time. Phase B sorts points **by `cmp_lex`** (or by a current rank snapshot), **not** by raw Vid arithmetic. The interner's dedup search is a `cmp_lex`-ordered structure (a sorted `Vec<Vid>` rank-index with binary-search-insert, or a `BTreeMap` keyed by a `cmp_lex`-consistent comparator). This keeps Vids stable across Phase-D TPI insertions while preserving a total exact order.

**D5. The refinement uses a flat current-leaves work-stack, not a refinement tree.** Census (doc `:425-430` referenced; ~85% of operands ≤128 tris, `k` small) → a flat walk + canonical pre-sort is simpler and in-budget; the O(log) refinement tree (Cherchi §5.2) is deferred unless a measured heavy-`k` fixture demands it. Point location stays exact regardless.

**D6. Scope = the proper-crossing `TriTri::Segment` case + its induced seg×seg TPI only.** `TriTri::Coplanar` (Cherchi §5.4 auxiliary-tetrahedron) and `TriTri::Degenerate` (vertex/edge-on-plane) stay deferred exactly as in `tritri.rs:116-119`. The §5.4 path, when built, must pre-decompose its overlap polygon into boundary segments fed into the SAME `RetriInput` vectors. **The d=0 (coplanar/parallel cutter) seg×seg case routes to a deterministic `BoolFailure` drain (un-cut host) until §5.4 lands** — see D7 — never a panic, never a silent dropped constraint.

**D7. The seg×seg TPI cutter-plane source is the reference `computeTriangleOfSegment` mechanism, NOT the two coplanar-with-T cutter triangles.** (Refutation high-flaw #1, decisive for conformity.) The **typical** in-plane crossing is two intersection segments *both lying in T's plane* crossing each other; their immediate supporting cutter triangles are frequently coplanar with T, so `det3(n_T, n_c1, n_c2)=0` and a naive TPI is degenerate. The reference does **not** defer here: `computeTriangleOfSegment()` searches the cutter mesh for an **alternative** incident triangle that is exact-`orient3d`-non-coplanar with T and uses THAT plane. M2.3 does the same: for each crossing constraint, derive its cutter plane from the **lexicographically-least** (by the cutter triangle's input-id, exact tie) cutter-incident triangle whose `orient3d` against T's three corners is non-`Zero`. Only if NO non-coplanar cutter triangle exists (a genuinely coplanar cutter) → route to the deferred §5.4 path / `BoolFailure` drain (D6). `mod.rs:87` `Tpi{planes:[[[f64;3];3];3]}` already represents an arbitrary 3-plane TPI → this is a spec gap, not a representation gap.

---

## 1. NEW kernel prerequisites this milestone REQUIRES (hard, gated before any topology output)

M2.3 cannot run on real data with only the shipped 1I predicates. After the first point split a sub-triangle's own corners are implicit (LPI/TPI), so point-location and ear tests routinely have 2 or 3 implicit args; `predicates.rs:32,56` `unimplemented!()` every non-1I config. These are **hard prerequisites**, gated exactly like the shipped 1I configs: BigRational oracle (`predicates.rs:318`-style) + CW/CCW winding-invariance + interval fast tier + the G2 FNV cross-platform sign manifest (`manifest.rs:50,82`) — **all green on x86_64/aarch64/wasm BEFORE M2.3 emits any topology** (doc `:86`: indirect topology-determinism is UNVERIFIED until G2 runs on each config).

### 1.1 Multi-implicit `orient2d` (2I, 3I) — verified sign rules

Verified against the exact materialised oracle, including the discriminating `d<0` plane-rewind cases. All feed the **existing** `assemble_sign` (`mod.rs:108-123`) unchanged (its per-odd-negative-denominator parity flip already implements this):

| config | `Λ'` numerator (drop axis → coords `i,j`) | `D'` | `den_signs` passed to `assemble_sign` |
|---|---|---|---|
| 1I `(I,E,E)` **SHIPPED** `rational.rs:199-206` | `(λ_i−d·c_i)(b_j−c_j) − (λ_j−d·c_j)(b_i−c_i)` | `d` | `[sign(d)]` |
| 2I `(I,I,E)` **NEW** | `(λ1_i−d1·c_i)(λ2_j−d2·c_j) − (λ1_j−d1·c_j)(λ2_i−d2·c_i)` | `d1·d2` | `[sign(d1),sign(d2)]` |
| 3I `(I,I,I)` **NEW** | `(d1·λ2_i−d2·λ1_i)(d1·λ3_j−d3·λ1_j) − (d1·λ2_j−d2·λ1_j)(d1·λ3_i−d3·λ1_i)` | `d1²·d2·d3` | `[sign(d2),sign(d3)]` (d1² squared → dropped) |

The 3I form matches Attene 2020 §4.3 *algebraically*; under the kernel's pre-scaled-λ convention the 2I/3I **flip rules are convention-stable** because `assemble_sign` flips only on odd-multiplicity negative denominators, and the flip is invariant under joint ±rescaling of `(λ_i,d_i)` (the joint-homogeneity property — must be re-asserted as a test for 3I, since the kernel diverges from Attene's raw-λ at 1I). Each config dispatches over `{Lpi,Tpi}` for **every** implicit arg; λ/d come from `lpi_lambda`/`tpi_lambda` (`rational.rs:84,137`) regardless of origin — the homogenisation depends only on implicit-row count (`rational.rs:112-114`), so 2I/3I are **type-agnostic** over LPI/TPI mixtures (one code path, not 2³ hand-written variants). Add `interval::` 2I/3I analogues mirroring `interval::indirect_orient2d` (`interval.rs:209-225`) so the BigRational fire rate stays low on coincident building faces (the existing interval gate asserts >0.95/0.80 definite, `predicates.rs:211,296`). `orient3d` stays 0/1-implicit in this layer (only the in-plane 2D earcut runs here); 2I/3I/4I `orient3d` remain deferred — discharged by audit in §6.

### 1.2 Full exact lexicographic comparator `cmp_lex(a,b) -> Sign` over `{Explicit,Lpi,Tpi}` — NEW

`lpi_compare_along` (`rational.rs:236-244`) orders two **LPI** points along **one** direction. M2.3's canonical sort and interner-weld need a **total** order over mixed `{Explicit,Lpi,Tpi}` (mirrors Attene `genericPoint::lessThan` → `lessThanOnX→Y→Z`):

```
cmp_lex(a,b): r = cmp_axis(a,b,0); if r==Zero { r = cmp_axis(a,b,1) }; if r==Zero { r = cmp_axis(a,b,2) }; r
```
`cmp_axis(a,b,k)` = exact sign of `(a_k − b_k)`:
- **E vs E:** `sign_of(a[k]−b[k])` on the raw f64 (exactly representable as BigRational, `rational.rs:14`).
- **I vs E** (a=λ/d, explicit b): `assemble_sign(sign(λ_a[k] − d_a·b[k]), [sign(d_a)])`.
- **I vs I:** `assemble_sign(sign(λ_a[k]·d_b − λ_b[k]·d_a), [sign(d_a), sign(d_b)])` — exactly `lpi_compare_along`'s shape (`rational.rs:242`) specialised to the axis unit vector `u=ê_k`, **extended to TPI** via `tpi_lambda`. With an axis-exact `u` this is the literal exact coordinate order (stronger than the approx-`u`/collinear precondition `lpi_compare_along` needs).

`cmp_lex(a,b)==Zero` ⇔ the two points are exactly coincident → the interner's symbolic weld. **Strict total order:** axis tie-break exhausts all 3 coordinates; if all three are exactly equal the points ARE the same point (collapse to one Vid, never compared by float). `cmp_lex` gets the same interval-first cascade as `orient2d` + an `interval::cmp_axis`. **Obligation (refutation low-flaw #5 + #2):** a property test must prove `cmp_lex` is a strict total order over a mixed `{E,Lpi,Tpi}` sample — **antisymmetry, transitivity, and Zero⇔coincidence** — and that a TPI and an LPI built from **different** line/plane triples but at the **same physical point** intern to the **same Vid regardless of insertion order** (interner search-path independence). This is the **determinism keystone** and a hard G2 prerequisite, not a deferred fixture.

---

## 2. Rust types

```rust
// kernel/retriangulate.rs

/// Stable symbolic identity of an arrangement vertex — NEVER a float coordinate.
/// Append-only insertion-order id (decision D4). GLOBAL across the operand (D3)
/// so a shared intersection point on two adjacent input triangles has ONE Vid.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct Vid(pub u32);

/// A canonical sub-segment constraint, endpoints by Vid, normalized (lo<hi by
/// LEX-RANK, not by raw Vid — D4). `constrained` half-edges are flagged on insert.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Constraint { pub lo: Vid, pub hi: Vid }   // lo,hi ordered by cmp_lex rank

pub struct RetriInput<'a> {
    pub tri: [Vid; 3],          // the 3 original-T corner Vids (already interned)
    pub drop_axis: DropAxis,    // PHASE A result; passed for reuse by L3
    pub w0: Sign,               // T's reference winding (PHASE A); every emitted sub-tri matches it
    pub points: &'a [Vid],      // interior + edge inserted points, ALREADY interner-deduped
    pub segments: &'a [Constraint],
    pub interner: &'a mut Interner, // GLOBAL: Vid -> &ImplicitPoint; Phase D MINTS new TPI Vids
    pub cutter_planes: &'a dyn Fn(Constraint) -> CutterPlaneSource, // D7: non-coplanar cutter tri lookup
}

pub struct RetriOutput {
    /// Each sub-tri's 3 Vids in T's winding orientation w0 (NOT sorted — L4 needs
    /// the orientation; the canonical SORTED form is produced only for hashing).
    pub tris: Vec<[Vid; 3]>,
    /// Set if Phase D hit a d=0 coplanar-cutter case (D6/D7): the host is emitted
    /// un-cut and L3 records a deterministic BoolFailure for this triangle.
    pub coplanar_cutter_deferred: bool,
}

/// Interner is owned by L3; M2.3 reads it and (Phase D only) appends TPI Vids.
/// Identity is SYMBOLIC: intern-or-find by EXACT cmp_lex, never rounded coords.
pub struct Interner {
    pts: Vec<ImplicitPoint>,   // Vid == index (stable, append-only)
    rank: Vec<Vid>,            // cmp_lex-sorted index for binary-search dedup (D4)
}
impl Interner {
    pub fn get(&self, v: Vid) -> &ImplicitPoint { &self.pts[v.0 as usize] }
    /// Returns the existing Vid on exact coincidence (cmp_lex==Zero), else a NEW Vid.
    pub fn intern(&mut self, p: ImplicitPoint) -> Vid { /* binary search `rank` via cmp_lex */ }
    pub fn lex_rank(&self, v: Vid) -> u32 { /* position of v in `rank` */ }
}
```

Working mesh during refinement: an index-based tri-adjacency `Vec` over `Vid`; any edge→tri lookup uses a `BTreeMap`/sorted-`Vec` keyed on `(Vid,Vid)` (no `HashMap` reaching output, doc `:209`). Pocket ring: `Vec<Vid>` from the boundary walk + `prev[]`/`next[]`. Ear selection: a `BinaryHeap` keyed by apex **lex-rank** (min at top).

---

## 3. Algorithm — step by step

### PHASE A — projection axis + reference winding (exact, once per T)
`DropAxis` chosen by the **exact** nonzero-projected-area condition (doc `:62-63`, Attene §4.5 *correctness* condition, not the "largest normal magnitude" first guess):
```
for axis in [largest-|normal-component| first, then the remaining two in fixed X,Y,Z order]:
    if orient2d(T0,T1,T2, axis) != Sign::Zero { return axis }   // EXACT, all-explicit
```
A non-degenerate `T` has ≥1 nonzero projection → pure function of input bytes, no ~45° platform divergence. Fix `w0 = orient2d(T0,T1,T2,axis)` as T's reference winding. **Every emitted sub-tri is oriented to match `w0`** so L4's normals are untouched by canonicalisation. (`orient3d` on T's three explicit corners may verify T's plane here — all-explicit, SHIPPED.)

### PHASE B — canonicalise (the determinism gate; ifc-lite addition)
1. Points are interner-deduped (`cmp_lex==Zero` ⇒ same Vid). Sort `points` ascending by **lex-rank** (`interner.lex_rank`) — O(k log k), the only superlinear step.
2. Normalise each segment to `Constraint{lo,hi}` with `lo<hi` **by lex-rank**; dedupe into a `BTreeSet<Constraint>` (key = the rank pair); iterate in `(lo-rank,hi-rank)` order. Replaces the reference LIFO `segment_list`.

After Phase B, insertion is a pure function of the input point/segment **set**.

### PHASE C — point insertion (Cherchi §5.2, "split triangles before edges")
Start from `[T0,T1,T2]`. For each point `p` in lex-rank order:
- **Locate** the current sub-triangle containing `p`: the three `orient2d(t0,t1,p)`, `orient2d(t1,t2,p)`, `orient2d(t2,t0,p)` are **all compatible with `w0`** under the perimeter-admitting rule *(no `Negative` present) OR (no `Positive` present)*, `Zero` compatible with both (Cherchi §5.2). After the first split these corners are implicit → **2I/3I orient2d** fire here.
- **Exactly one `Zero`** → `p` on that sub-edge → **edge split** (split both sub-tris sharing the edge; in a single-tri mesh, the one). **HARD canonical tie (doc `:102`):** an on-edge point ALWAYS edge-splits, never tri-splits — removes the two-valid-hosts ambiguity (matches reference `fastPointOnLine` precedence).
- **Two `Zero`** → `p` coincides with an existing vertex → **skip** (the interner already collapsed it; this is the `cmp_lex==Zero` case, never a float weld).
- **Zero `Zero`s** (strict interior) → **1→3 fan split**, all `w0`-oriented.
Redistribute not-yet-inserted points to children by the same exact test. Result: a triangulation of `T` with vertices = 3 originals + inserted points; constraints not yet enforced.

### PHASE D — segment (constraint) insertion (Cherchi §5.3 Alg.1)
For each `Constraint{a,b}` in canonical `(lo-rank,hi-rank)` order:
1. **Already an edge chain?** If `(a,b)` is a union of existing sub-tri edges, flag every one constrained, continue.
2. **Partial collinear overlap with a T edge / existing edge (refutation medium-flaw #3):** if `(a,b)` is collinear with an existing edge's supporting line but only partially overlaps (one endpoint strictly interior to that edge), Phase C has already edge-split the interior endpoint; **propagate the `constrained` flag to EVERY half-edge along the constraint's span** (the freshly-split sub-segments included). Detect collinearity by `orient2d(edge0,edge1,p)==Zero` first, then strict betweenness via the `lpi_compare_along` projection (§3.4). The conformity check (postcondition b) verifies `(a,b)` as a contiguous chain that **may include split T-edge sub-segments**.
3. **Walk** from `a` toward `b`, collecting every sub-triangle whose interior the **open** segment crosses (exact `inner_segments_cross` + `point_on_inner_segment`, §3.4).
4. **Seg×seg interior crossing → NEW TPI vertex** (Cherchi §5.3 Fig 6, `createTPI`). The crossing point's TPI is built from {**a non-coplanar-with-T cutter triangle for constraint 1**, **... for constraint 2**, and a third independent plane} per **D7** — NOT the coplanar immediate supporting triangles. Concretely: TPI planes = the two cutter planes from `cutter_planes(c1)`,`cutter_planes(c2)` (each the lexicographically-least cutter-incident triangle with `orient3d` vs T ≠ `Zero`) plus T's own plane — giving 3 linearly-independent planes (doc `:218`). **Guard BEFORE constructing:** exact `inner_segments_cross` with *strict* interior (reject collinear-overlap / shared-endpoint → those reuse an existing Vid, handled by step 1/2, not a TPI); compute `d=det3(n1,n2,n3)` exactly — if `d==0` (no non-coplanar cutter found → genuinely coplanar cutter) set `coplanar_cutter_deferred=true`, emit the host un-cut, and **route to the §5.4/`BoolFailure` drain (D6)** — never materialise a bad point, never panic. Else construct `ImplicitPoint::Tpi` (`mod.rs:87`, first kernel use), `intern()` it (gets a Vid via `cmp_lex` — collapses to the same Vid if the geometrically-identical crossing already exists in an adjacent triangle, D3), `splitEdge` the crossed existing constraint at the TPI, split `(a,b)` into `(a,TPI)+(TPI,b)`, **recurse in canonical `(lo-rank,hi-rank)` order** (preserves Phase-D order-independence).
5. **Delete** the crossed sub-triangles → a polygonal hole; `(a,b)` splits it into **two pockets** `Pl,Pr` sharing `(a,b)` as base.
6. **Triangulate each pocket** with the deterministic Simplified Earcut (Phase E); re-insert the new ears.

### PHASE E — deterministic Simplified Earcut of one pocket `P=[p1..pn]`, base `(p1,pn)=(a,b)`
Doubly-linked ring via `prev[]`/`next[]`, extracted by an explicit **border march** (Simplified Earcut §4 / Fig 4) that **duplicates geometrically-coincident vertices into distinct ring positions** so the ring is *topologically* simple even where symbolic-Vid welding made two boundary vertices the same point (refutation low-flaw #6). **Debug assert** each pocket is a simple, non-degenerate ring **weakly visible from `(a,b)`** (§5.1) before the earcut; a pocket whose welding collapsed two boundary vertices to a zero-area ring routes to the §5.4 degenerate drain (D6), never feeds the no-containment earcut.

**Pocket interior sign — HARD exact rule, NOT bootstrapped from the walk** (refutation medium-flaw on the open question): `interior_sign(P) = orient2d(a, b, r, axis)` where `r` = the **least-lex-rank pocket-interior vertex**; the opposite pocket's interior sign is its flip. Pure exact function of the directed base `a→b` + drop axis. Referenced by every ear convexity test in `P`.

**Theorem (Simplified Earcut §5.2):** any **strictly-convex** internal vertex `v` along the chain connecting the base endpoints forms a valid ear — the five points `{v,vl,ṽl,ṽr,vr}` form a strictly-convex pentagon ⊂ P, so the ear contains no other vertex → **no in-ear/containment test**. The two **lateral** (base-endpoint) ears are **NEVER cut** (§5.3). Convexity of internal `v`: `orient2d(prev(v),v,next(v),axis) == interior_sign(P)` (one orient2d; 0/1/2/3 implicit args → §1.1). **Collinear chain vertices (refutation low-flaw #4):** a vertex with `orient2d(prev,v,next)==Zero` is an interior angle of exactly π → classified **non-ear** (not strictly convex); it is removed only when an adjacent ear cut splices it out. So the invariant is **`≤ n−2` distinct apex cuts, terminating because a strictly-convex internal ear always exists** (§5.4: any simple polygon has ≥3 convex vertices; with exactly 2 lateral ears the 3rd is internal) — **not** the unconditional `n−2` the paper states. **Determinise ear order (ifc-lite):** a min-heap of cuttable internal ears keyed by apex **lex-rank**; each step pop the least-rank ear, emit `(prev,apex,next)` oriented to `w0`, splice `apex` out, re-test the two neighbours, push if newly strictly-convex → diagonals a pure function of the (geometry-determined) ring sequence. **All-`orient2d`-Zero degenerate fan** (cocircular-square / collinear-Steiner, doc `:102`): the apex-lex-rank min already breaks it; stated as a HARD rule in `retriangulate.rs`, never deferred to G2. Complexity O(k log k) with the heap (the paper's O(n) becomes O(n log n) only via the determinism heap — within the design's O(k log k) target already set by Phase B).

### PHASE F — emit
Each sub-tri carries `[Vid;3]` in `w0` orientation; its operand tag = T's input-tri id (for L4's per-cell winding-vector slot). For the **canonical hash** (G2) only: also produce the sorted-Vid triple + an orientation-parity bit and sort the whole list — that is what gets hashed; emitted `tris` keep `w0` order.

**Postconditions (exact oracles, debug):** (a) **covers exactly T** — BigRational signed-area sum of all sub-tris (via `orient2d` magnitude) equals T's, no sub-tri zero/flipped; (b) **conforming** — every `Constraint` (including partial-T-edge spans, D-step 2) appears as a contiguous chain of `constrained` sub-tri edges; (c) **intersection-free** — no sub-tri interior crosses any constraint (exact `inner_segments_cross` against all constraints).

### 3.4 Derived exact wrappers (compose `orient2d`/`cmp_lex`, all NEW thin helpers)
- `point_in_triangle(p,t0,t1,t2,axis)` = three `orient2d` signs perimeter-admitting (§Phase C).
- `point_on_inner_segment(p,a,b,axis)` = `orient2d(a,b,p)==Zero` **first**, THEN strict betweenness via `lpi_compare_along`-style projection on the segment direction (refutation low-flaw #4: use the along-line projection, **not** `cmp_lex`, with the collinearity precondition asserted first). Edge-split + partial-overlap detection.
- `inner_segments_cross(a0,a1,b0,b1,axis)` = four `orient2d` signs (each endpoint pair strictly straddles the other segment). Phase-D conflict / TPI trigger. When endpoints are themselves implicit (an already-inserted TPI/LPI crossed again), this is a 2I/3I `orient2d` chain — covered by §1.1.

---

## 4. Conformity & determinism arguments

**Conformity** (Cherchi §5.2–5.3): Phase C makes every inserted point a mesh vertex; Phase D enforces every segment (and every partial-T-edge span, D-step 2) as a union of `constrained` edges; the earcut theorem fills each pocket with no constraint-crossing diagonal; the D7 TPI handling turns seg×seg crossings into **shared** vertices with a **non-degenerate** defining plane triple, so two constraints never pass through each other unrecorded and no genuine crossing is silently dropped (the §5.4/`BoolFailure` drain handles only true coplanar-cutter degeneracies, deterministically).

**Determinism / order-independence** (ifc-lite-engineered; NOT inherited): the output is a pure function of `(T, point-set, segment-set)` because **every** decision uses only (i) exact predicate **signs** — proven platform-identical for the explicit substrate (floor spike) and to be proven for 2I/3I/`cmp_lex` by the G2 manifest before M2.3 ships (`manifest.rs:50,82`; doc `:86`) — and (ii) the exact **lex-rank** total order. **The pocket RING fed to Phase E is itself a pure function of the set** (refutation high-flaw on ring construction): the deleted-triangle set for each constraint is exactly the set the open segment's interior crosses, decided only by `orient2d`/`inner_segments_cross` signs against the **current mesh**, and the current mesh after Phase C + earlier **canonical-order** constraints is (by induction) itself a pure function of the set; the seg×seg TPI subdivision recurses in canonical `(lo-rank,hi-rank)` order. Insertion order is fixed by lex-rank (Phase B); ear order by apex-lex-rank (Phase E); on-edge/coincident ties by HARD canonical rules (always-edge-split; always-reuse-Vid via `cmp_lex==Zero`); the all-`orient2d`-Zero fan by lexicographically-least lex-rank, stated as a HARD rule in `retriangulate.rs` (doc `:102` — "G2 detects divergence, it does not prevent it"). Vertex identity is **symbolic only** (Vid via `cmp_lex`), never a float weld — the documented FATAL risk (doc `:198-204`). **Global** Vids (D3) make the shared seam between adjacent re-triangulated triangles match. The load-bearing claim — that this whole pipeline is order-/platform-invariant — is **discharged by a constructive proof obligation, not assertion**: a fuzz harness that runs the SAME `(point-set, segment-set)` through random pre-canonicalisation shuffles and asserts a byte-identical `(sorted-Vid-set + orientation-parity)` hash, plus the x86/aarch64/wasm triple (testMatrix T7/T8).

---

## 5. Interface to L3 / L4

- **From L3 (consumes):** `RetriInput` per intersected input triangle. L3 **owns the global `Interner` (D3)** and builds it over the whole-arrangement vertex set before M2.3 runs, deduping by `cmp_lex` (§1.2). L3 Phase-2 (doc `:215`) produces the `Lpi` segment endpoints (from `tritri::tri_tri_intersection`, exact) and interns them; L3 also supplies the `cutter_planes` lookup (D7: per constraint, the non-coplanar-with-T cutter triangle from the operand's mesh). L3 Phase-3/4 (doc `:216-218`) **are** this module's Phases C/D. Phase-D TPIs are interned into the same global space (shared if the same crossing arises in an adjacent triangle). On `coplanar_cutter_deferred`, L3 records a deterministic per-triangle `BoolFailure` (un-cut host) until §5.4 lands.
- **To L4 (produces):** `RetriOutput.tris` — `w0`-oriented `[Vid;3]` sub-triangles. L4 reads `(sorted Vids + orientation parity)` for its winding-number vector + radial sort (doc `:234`-onward); `w0` orientation is preserved so L4 normals are not silently flipped. Each sub-tri inherits T's operand tag. The global Vid space is exactly what L4's symbolic vertex identity (doc `:225`) and BTreeMap-keyed cell graphs (doc `:209`) require.

---

## 6. Predicate call inventory (NEW vs SHIPPED)

| call | where | status |
|---|---|---|
| `orient2d` 1I `(I,E,E)` over `{Lpi,Tpi}` | Phase A axis, point-loc vs original corners | **SHIPPED** `predicates.rs:41`, `rational.rs:199` |
| `orient2d` **2I** `(I,I,E)` | location/ear after first split | **NEW** §1.1 (verified) |
| `orient2d` **3I** `(I,I,I)` | all-implicit pocket ear | **NEW** §1.1 (verified, = Attene §4.3 algebraically) |
| interval 2I/3I `orient2d` | fast tier | **NEW** mirror `interval.rs:209` |
| `cmp_lex(a,b)` total lex order over `{E,Lpi,Tpi}` (+ interval `cmp_axis`) | Phase B sort, interner dedup, min-rank ties | **NEW** §1.2 (only `lpi_compare_along` exists, `rational.rs:236`) |
| `point_in_triangle` / `point_on_inner_segment` / `inner_segments_cross` | Phase C/D | **NEW** thin compositions §3.4 |
| seg×seg TPI constructor + D7 cutter-plane source + `d≠0` guard | Phase D | **NEW** *use* of `Tpi` (`mod.rs:87`); `det3` of explicit normals (safe, all-explicit) |
| `orient3d` | Phase A plane verify; D7 cutter non-coplanar test (all-explicit T corners) | **SHIPPED** (0/1-implicit suffices — §6 audit) |
| incircle / insphere | — | **NONE** — deliberately absent (Simplified Earcut §6) |

**§6 audit (discharges the draft's "confirm no multi-implicit orient3d" TODO):** Phase A calls `orient3d`/`orient2d` on T's explicit corners only. D7's cutter-non-coplanar test is `orient3d(T0,T1,T2, cutter_vertex)` — cutter vertices are explicit input coords, T corners explicit → all-explicit `orient3d` (SHIPPED). The TPI `d≠0` guard is `det3` of three explicit plane normals → all-explicit. No call site reaches multi-implicit `orient3d`; 2I/3I/4I `orient3d` remain correctly deferred. **Add a debug guard** asserting the `orient3d` dispatch never hits its `unimplemented!()` arm (`predicates.rs:32`).

**Sources:** Cherchi/Livesu/Scateni/Attene, *Fast and Robust Mesh Arrangements*, SIGGRAPH Asia 2020, §4.1–4.5, §5.1–5.4. • Livesu/Cherchi/Scateni/Attene, *Deterministic Linear Time Constrained Triangulation using Simplified Earcut*, IEEE TVCG 28(12) 2022, arXiv:2009.04294, §4 Alg.1, §5.1–5.4, §6 (no Delaunay property; "extract one ear" unordered; border-march duplicates coincident vertices, Fig 4). • Cherchi/Pellacini/Attene/Livesu, *Interactive and Robust Mesh Booleans*, SIGGRAPH Asia 2022, arXiv:2205.14151, §4. • Attene, *Indirect Predicates for Geometric Constructions*, CAD 2020, arXiv:2105.09772v2, §4.2–4.6 (`D'`/flip per config — raw-Cramer-λ convention; projection axis). • kernel: `mod.rs:66-123`, `predicates.rs:22-60,318-338`, `rational.rs:84-244`, `interval.rs:121-235`, `tritri.rs:111-154`. • design doc `pure-rust-csg-kernel.md:54-55,62-63,86,99-103,109-119,205-218,225,303-306,373,390-391`.

**Two corrections the implementer MUST apply before coding:** (1) correct **both** doc sign-table rows `pure-rust-csg-kernel.md:54` AND `:303` to `orient2d 1I: D'=d (odd) → flip on sign(d)` with the pre-scaled-λ-convention note (D1); the shipped code is ground truth — do NOT change it; add the missing orient2d plane-winding-invariance regression test. (2) `cmp_lex` + 2I/3I `orient2d` (rational + interval) are HARD prerequisites that must pass the G2 cross-platform sign manifest (`manifest.rs:82`) before any topology output is trusted.


## M2.3 new predicates required

- orient2d 2I (I,I,E) over {Lpi,Tpi}^2 — rational (kernel/rational.rs). Construction: from lpi_lambda/tpi_lambda get (λ1,d1),(λ2,d2); project with axis_idx; Λ' = (λ1_i−d1·c_i)(λ2_j−d2·c_j) − (λ1_j−d1·c_j)(λ2_i−d2·c_i); return assemble_sign(sign(Λ'), &[sign(d1),sign(d2)]). Mirrors rational::indirect_orient2d (rational.rs:199) generalised to two implicit rows; type-agnostic over LPI/TPI because λ/d depend only on row count.
- orient2d 3I (I,I,I) over {Lpi,Tpi}^3 — rational. Construction: (λ1,d1),(λ2,d2),(λ3,d3); Λ' = (d1·λ2_i−d2·λ1_i)(d1·λ3_j−d3·λ1_j) − (d1·λ2_j−d2·λ1_j)(d1·λ3_i−d3·λ1_i); D'=d1²·d2·d3 so den_signs=&[sign(d2),sign(d3)] (d1² dropped — squared denominators MUST NOT enter assemble_sign, mod.rs:98). Algebraically = Attene 2020 §4.3; flip-rule convention-stable under the kernel's pre-scaled λ by the joint-homogeneity property (asserted by test).
- interval::orient2d 2I + 3I — fast tier (kernel/interval.rs). Mirror interval::indirect_orient2d (interval.rs:209-225): same Λ' built over RnInterval (next_up/next_down directed rounding, no FMA), each d_i.sign()? short-circuits on a straddle (None ⇒ escalate to rational). Keeps BigRational fire-rate under the existing >0.95/0.80 gate (predicates.rs:211,296).
- cmp_lex(a,b: &ImplicitPoint) -> Sign — full lexicographic total order over {Explicit,Lpi,Tpi} (kernel/rational.rs + interval cmp_axis). Construction: cmp_axis(a,b,0) then ,1 then ,2; cmp_axis = E/E: sign_of(a[k]−b[k]); I/E: assemble_sign(sign(λ_a[k]−d_a·b[k]),&[sign(d_a)]); I/I: assemble_sign(sign(λ_a[k]·d_b−λ_b[k]·d_a),&[sign(d_a),sign(d_b)]) (= lpi_compare_along shape rational.rs:242 specialised to u=ê_k, extended to TPI via tpi_lambda). Zero on all three axes ⇔ exact coincidence (interner weld). Strict total order — proven by property test (antisymmetry+transitivity+coincidence). Interval-first cascade like orient2d.
- point_in_triangle(p,t0,t1,t2,axis) -> bool — thin orient2d composition: three orient2d signs perimeter-admitting (no Negative present OR no Positive present, Zero compatible). NEW wrapper, no new math.
- point_on_inner_segment(p,a,b,axis) -> bool — orient2d(a,b,p)==Zero (collinearity precondition FIRST) then strict betweenness via the lpi_compare_along projection on the segment direction (rational.rs:236), NOT cmp_lex. NEW wrapper.
- inner_segments_cross(a0,a1,b0,b1,axis) -> bool — four orient2d signs, each endpoint pair strictly straddles the other segment (strict interior). When endpoints are implicit, the orient2d calls are 2I/3I. NEW wrapper.
- Seg×seg TPI constructor + D7 cutter-plane source — NEW use of ImplicitPoint::Tpi (mod.rs:87). Planes = {non-coplanar cutter tri for constraint 1, ... for constraint 2, T's plane} (3 linearly-independent, doc:218); cutter tri = lexicographically-least cutter-incident triangle with orient3d vs T's corners != Zero (computeTriangleOfSegment analogue). Validity guard: d=det3(n1,n2,n3) exact; d==0 ⇒ coplanar-cutter ⇒ BoolFailure/§5.4 drain, never a panic or dropped constraint.

## M2.3 increments

- **M2.3.0** — Multi-implicit orient2d (2I, 3I) rational tier + interval fast tier, over all {Lpi,Tpi} mixtures, feeding the existing assemble_sign unchanged.
  - *exit:* Per-config BigRational oracle test (homogenised == direct orient2d on the materialised λ/d point, mirroring predicates.rs:318) passes for 2I and 3I on an adversarial battery; plane-rewind winding-invariance test passes (catches a missing/extra sign(d) flip); interval tier is sound vs oracle with >0.95 (2I)/>0.80 (3I) definite rate; cascade==exact on a fixed-seed fuzz.
- **M2.3.1** — cmp_lex total lexicographic comparator over {Explicit,Lpi,Tpi} (rational + interval cmp_axis), plus the global Interner with cmp_lex intern-or-find and a decoupled stable-Vid/lex-rank index (D4).
  - *exit:* Property test proves cmp_lex is a strict total order (antisymmetry + transitivity + Zero⇔coincidence) over a mixed E/LPI/TPI sample; a TPI and an LPI built from DIFFERENT triples at the SAME physical point intern to the SAME Vid regardless of insertion order; Vids stay stable across mid-stream interns.
- **M2.3.2** — G2 cross-platform sign manifest extended to cover 2I/3I orient2d + cmp_lex (append to manifest.rs:50 battery, re-pin SIGN_MANIFEST).
  - *exit:* indirect_sign_manifest_is_pinned passes; the SAME pinned hash verified byte-identical on x86_64, aarch64 (real ARM runner), wasm32 — the determinism bar for the new predicate configs BEFORE any topology output.
- **M2.3.3** — PHASE A (exact projection axis + w0 reference winding) and PHASE B (canonical lex-rank point sort + (lo,hi)-rank segment BTreeSet).
  - *exit:* Axis chosen by the exact nonzero-projected-area condition (near-axis-aligned + ~45° fixtures, no magnitude tiebreak divergence); permuting the input point/segment order yields an identical canonical (sorted) work list; w0 fixed and reused.
- **M2.3.4** — PHASE C point insertion (locate via 3× orient2d, interior 1→3 / on-edge 4-split / on-vertex skip, with the HARD always-edge-split and always-reuse-Vid tie rules); child point redistribution.
  - *exit:* A triangle with interior + on-edge + on-vertex inserted points triangulates to the right child count, covers exactly T (BigRational signed-area oracle), no flipped/zero sub-tri; on-edge points never tri-split; coincident points collapse to one Vid.
- **M2.3.5** — PHASE D segment insertion for the NON-crossing cases: already-an-edge-chain (flag constrained) + partial-collinear-T-edge-overlap flag propagation (D-step 2) + crossed-triangle walk/delete + two-pocket extraction by border march.
  - *exit:* Every constraint (full-edge, partial-T-edge span, and clean interior) appears as a contiguous chain of constrained sub-tri edges (conformity postcondition b); a constraint that is a sub-segment of a T edge with one interior endpoint is fully flagged; pockets are simple non-degenerate rings (debug assert).
- **M2.3.6** — PHASE E deterministic Simplified Earcut per pocket: HARD exact interior_sign rule (least-lex-rank interior vertex), strict-convexity ear test, min-apex-lex-rank ear heap, lateral ears never cut, collinear vertices non-ear, termination-not-exact-count invariant.
  - *exit:* Non-convex pockets on both sides of the base triangulate correctly (w0-oriented, cover the pocket, no overlap); a pocket with three collinear boundary vertices terminates with ≤ n−2 cuts; ear diagonals are a pure function of the ring sequence (shuffle test).
- **M2.3.7** — PHASE D seg×seg TPI: D7 non-coplanar cutter-plane source (computeTriangleOfSegment analogue), exact d≠0 guard, intern + edge-split + canonical-order recurse; coplanar-cutter (d==0) BoolFailure/§5.4 deterministic drain.
  - *exit:* Two segments both in T's plane crossing, whose immediate supporting cutter triangles are coplanar-with-T, construct a VALID TPI (d≠0) from an alternative non-coplanar cutter triangle and yield a conforming result; the same crossing arising in an adjacent triangle interns to the SAME Vid (seam conforms); a genuinely coplanar-cutter case routes to BoolFailure un-cut, never panics, never drops the constraint.
- **M2.3.8** — PHASE F emit (w0-oriented [Vid;3] + canonical sorted-Vid/parity hash) + the L3/L4 RetriInput/RetriOutput interface + the three debug postcondition oracles (coverage, conformity, intersection-free).
  - *exit:* All three postconditions assert clean on the full fixture battery; a single (point,segment) set run through random pre-canonicalisation shuffles produces a byte-identical topology hash; output consumed by a stub L4 winding pass without orientation flips.

## M2.3 critical risks

- #1 Wrong indirect orient2d sign flip (the doc-vs-code conflict). BOTH doc sign tables (pure-rust-csg-kernel.md:54 AND :303) say orient2d 1I = d² → NO flip; the shipped code (rational.rs:206, indirect_orient2d) correctly uses a d¹ flip because the kernel pre-scales λ by d (rational.rs:96). An implementer following the doc — or copying Attene's raw-λ D' for 2I/3I — inverts point-location over every LPI/TPI vertex with d<0 (≈half of host faces), invisible to tri-count tests. Mitigation: correct BOTH doc rows + record the pre-scaled-λ convention; keep the code; add the missing orient2d plane-winding-invariance regression test; gate 2I/3I via the materialised-point oracle.
- #2 Pipeline-wide order-/platform-NON-invariance of the POCKET RING, not just the final ear step. The papers guarantee linear TIME only, not output uniqueness (arXiv:2009.04294 §4 'extract one ear' unordered, raw-input-order LIFO reference). The draft determinises the earcut but the ring it consumes is produced by Phase C + canonical-order Phase D + mid-stream TPI subdivision; if the deleted-triangle set or TPI recursion is order-dependent, two platforms hand the earcut DIFFERENT rings → different topology, silently corrupting the boolean. Mitigation: the constructive purity argument (§4) PLUS a fuzz harness asserting byte-identical (sorted-Vid+parity) hash across random pre-canonicalisation shuffles + the x86/aarch64/wasm triple — discharge by test, never by assertion.
- #3 Seg×seg TPI cutter-plane source + the d=0 degeneracy. The COMMON in-plane crossing has both cutter segments coplanar-with-T, so a naive TPI from the immediate supporting triangles is degenerate (d=0); 'assert d≠0 else defer' would mis-handle the MAJORITY of real crossings and silently drop/defer constraints (non-conforming). Mitigation: D7 — derive each cutter plane from a non-coplanar-with-T cutter-incident triangle (computeTriangleOfSegment analogue, lexicographically least); only a genuinely coplanar cutter (no non-coplanar triangle exists) routes to a deterministic BoolFailure/§5.4 drain. Near-coplanar wall/slab stacks (the L5 motivation) are not rare → this must be built, not hand-waved.
- #4 Float weld re-introducing cross-platform topology divergence. Any rounding of an implicit point to identify vertices buckets differently near a half-cell boundary across platforms → different adjacency → different topology (doc:198-204, the documented FATAL risk). Mitigation: vertex identity is SYMBOLIC ONLY via cmp_lex==Zero (the interner); never a float weld anywhere in M2.3; the interner-weld correctness (cmp_lex total-order + insertion-order independence) is a hard G2 prerequisite proven by property test before topology output.
- #5 The new predicate layer (2I/3I orient2d + cmp_lex + interval twins) is UNVERIFIED for cross-platform determinism until it clears the G2 sign manifest — and it is a substantial build buried inside what reads as 'just re-triangulation'. Mitigation: sequence M2.3.0–M2.3.2 (predicates + G2 manifest) as hard gates BEFORE any topology increment; mirror exactly the proof apparatus the shipped 1I configs already have (oracle + winding-invariance + interval-soundness + FNV manifest on x86_64/aarch64/wasm).
- #6 Pocket non-simplicity / weak-visibility precondition violated by symbolic-Vid welding. The earcut's no-containment guarantee rests on a SIMPLE pocket weakly visible from the base (§5.1); a TPI welded to an existing boundary vertex could collapse the ring to non-simple/zero-area. Mitigation: extract the ring via the explicit border march that duplicates coincident vertices (Fig 4) → topologically simple; debug-assert simplicity + weak visibility; route a collapsed-ring pocket to the §5.4 degenerate drain rather than feeding the earcut.

## M2.3 test matrix

- T1 Conformity: every inserted Constraint appears as a contiguous chain of constrained sub-tri edges — for full-edge, clean-interior, AND partial-T-edge-overlap (constraint = sub-segment of a T edge with one interior endpoint, D-step 2) constraints.
- T2 Coverage: BigRational signed-area sum of all sub-tris == T's signed area; no zero-area or w0-flipped sub-tri (PHASE C and after each PHASE D constraint).
- T3 Intersection-free: exact inner_segments_cross of every sub-tri edge against every constraint returns no strict-interior crossing (debug postcondition c).
- T4 Order-invariance (the keystone): the SAME (point-set, segment-set) run through N random pre-canonicalisation shuffles yields a byte-identical (sorted-Vid-set + orientation-parity) topology hash — covers Phase B sort, Phase C insertion, Phase D segment + TPI recursion, Phase E ear order.
- T5 Cross-platform determinism: the topology hash AND the extended G2 sign manifest (manifest.rs, now covering 2I/3I orient2d + cmp_lex) are byte-identical on x86_64, aarch64 (real ARM runner), wasm32.
- T6 Predicate oracle: 2I/3I orient2d homogenised == direct orient2d on the materialised λ/d point for every drop axis + every {Lpi,Tpi} mixture, on an adversarial battery (coincident faces, near-coplanar at k·ULP for k∈{0,1,2,16}, collinear, near-axis-aligned); plane-rewind winding-invariance for orient2d 1I/2I/3I (the d<0 discriminator).
- T7 cmp_lex total order: property test for antisymmetry + transitivity + Zero⇔coincidence over a mixed {E,Lpi,Tpi} sample; a TPI and an LPI from DIFFERENT line/plane triples at the SAME physical point intern to the SAME Vid regardless of insertion order (interner search-path independence).
- T8 Seg×seg TPI (D7): two segments both in T's plane crossing, immediate supporting cutter triangles coplanar-with-T — assert a valid TPI with d≠0 is built from an alternative non-coplanar cutter triangle and the result is conforming; the same crossing in an adjacent triangle interns to one Vid (seam conforms).
- T9 Coplanar/parallel-cutter degeneracy: a genuinely coplanar cutter (no non-coplanar incident triangle) deterministically routes to BoolFailure (un-cut host) — never panics, never drops the constraint; IFC-realistic near-coplanar wall/slab-stack fixture.
- T10 Degenerate-fan tie-break: cocircular-square + collinear-Steiner pockets (all orient2d Zero) resolve by lexicographically-least lex-rank as a coded HARD rule; output identical across shuffles and platforms.
- T11 Collinear pocket boundary: a pocket with three collinear boundary vertices terminates (≤ n−2 distinct apex cuts), no infinite loop, collinear vertex classified non-ear and spliced out only as an adjacent-cut neighbour.
- T12 On-edge / on-vertex point classification: an inserted point exactly on a sub-edge ALWAYS edge-splits (never tri-splits); a point coincident with a vertex is skipped (one Vid); covers the two-Zero / one-Zero / zero-Zero branches and their HARD precedence.
- T13 Projection-axis exactness: near-axis-aligned and ~45° T planes select the drop axis by the exact nonzero-projected-area condition with no float-magnitude tiebreak divergence across platforms.
- T14 No multi-implicit orient3d reached (§6 audit guard): a debug assertion / test confirms the orient3d dispatch never hits its unimplemented!() arm during a full M2.3 run; D7's cutter-non-coplanar test and the d≠0 det3 guard are all-explicit.
