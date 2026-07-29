# B4.4 - the M3 kernel-adjoint spike

Run 2026-07-27, off `origin/main` at `40b4eabb`.

**Verdict: PASS.** 200/200 points (100.00%) on the pre-committed
rectangular-extrusion battery, against a 95% bar. Replicated at two further
seeds (200/200, 200/200) and on a harder second family that adds a rectangular
void (200/200, 200/200, 199/200).

The exam, as pre-committed in
[`docs/vision/moonshots-finishing-plan.md`](../../../docs/vision/moonshots-finishing-plan.md)
section 4 (M3):

> Adjoints through the real mesher on the rectangular-extrusion family,
> differentiating divergence-theorem volumes with respect to design parameters,
> matching central finite differences to 1e-6 relative on 95% of a 200-point
> seeded battery.

---

## 1. What "the real mesher" means here, and how it was made differentiable

### 1.1 The choice

B2.4/B3.3 differentiated closed-form volume formulas that *mirror* what the
kernel computes. The G2 red team's finding was that this proves nothing about
the kernel. So the only acceptable design was one where the derivative flows
through the bytes of the shipping mesher, not through a second implementation
of it.

Three options were on the table (dual numbers through a generic mesher;
complex-step; declare it intractable). **Option 1 was taken.** The extrusion
mesher is now generic over a scalar trait, with `f64` as the production
instantiation and a forward-mode dual number as the spike's:

```
rust/geometry/src/scalar.rs             GeomScalar + MeshSink traits, f64 impls
rust/geometry/src/extrusion_generic.rs  the mesher body, generic over the scalar
rust/geometry/src/profile_generic.rs    profile ring + triangulation, generic
rust/geometry/src/extrusion.rs          extrude_profile / apply_transform = the f64 instantiations
rust/geometry/src/processors/extrusion.rs  extrusion_local_transform, generic
```

Complex-step was rejected on inspection: nalgebra's `norm`/`normalize` route
through `modulus_squared`, which conjugates and therefore annihilates the
imaginary perturbation. It would have needed the same generic refactor *plus* a
vendored complex type with non-standard `abs`.

### 1.2 What is actually instrumented

The differentiated chain, end to end, with the production symbol that runs each
step:

| step | production code | generic? |
|---|---|---|
| `(xdim, ydim)` -> profile ring | `profile_generic::rectangle_ring` (shared with `ProfileProcessor::process_rectangle`) | yes |
| ring -> cap triangulation | `profile_generic::triangulate_rings` -> `triangulation::safe_earcut` | positions yes, **connectivity primal** (see 1.3) |
| `(dirx,diry,dirz,depth)` -> local transform | `processors::extrusion::extrusion_local_transform` (normalize, axis-alignment test, shear or `-depth` translation) | yes |
| profile + depth -> mesh | `extrusion_generic::extrude_rings_into` (aspect-ratio veto, both caps, outer side walls, hole side walls, winding-sign logic, degenerate-edge skip, smooth-radial-normal test) | yes |
| placement transform | `extrusion_generic::apply_transform_generic` -> `scalar::transform_point4` | yes |
| mesh -> volume | divergence theorem over the emitted index triangles | yes |

Invasiveness: the refactor is a signature change plus mechanical substitution
of `f64` constants for `S::from_f64(...)`. Six nalgebra calls that need
`RealField` (`Vector3::magnitude_squared`, `::try_normalize`,
`Matrix4::transform_point`, `Vector3::normalize`) were replaced with hand-written
equivalents in `scalar.rs`, each **asserted bit-identical to nalgebra's** over
2,000-4,000 random inputs (`scalar::tests`). Two production files were split to
stay inside the module-size ratchet; that is a pure move.

### 1.3 What is *not* differentiated, and why that is correct

**Ear clipping.** `safe_earcut` returns a list of integer indices. It is a
discrete map, constant on an open neighbourhood of almost every input, so its
derivative is zero almost everywhere and undefined on a measure-zero set of
seams. It is therefore evaluated on the **primal** values and its output used
verbatim for the dual pass; `triangulate_rings` returns the ring vertices
themselves (earcut adds no Steiner points), so no coordinate is ever recomputed.
This is what differentiating a piecewise-smooth map means: the derivative of the
branch the real ear clipper selected. A point that lands within `h` of a
combinatorial seam would honestly fail FD, and the protocol accepts that inside
its 5% budget.

**Normals.** The divergence-theorem volume is a function of positions and
indices only, so the dual mesh sink drops the normal buffer
(`MeshSink::transform_normals` is a no-op for it). The `f64` sink runs the
production normal path verbatim. This is a deliberate, stated shortcut.

**The placement matrix.** `parse_axis2_placement_3d` reads decoded IFC
attributes and cannot be made generic; the battery builds the equivalent
`Matrix4<S>` (rotation about Z, then translation) in harness code. It is a rigid
motion, which is exactly why the placement parameters are in the box: they are
the battery's exact-zero controls (section 3.2).

**CSG.** This bet does **not** establish adjoints through booleans. The
pre-committed exam is about the mesher; the CSG obstruction analysis is in
section 6 and remains open.

### 1.4 Production behaviour is byte-identical, and it is proved, not asserted

`rust/geometry/src/extrusion_byte_identity_tests.rs` holds **verbatim copies**
of `extrude_profile`, `Profile2D::triangulate`, `create_cap_mesh`,
`create_side_walls`, both predicates, `apply_transform` and the processor's
direction handling as they stood at `40b4eabb`, and drives both implementations
over 4,000 seeded cases covering every branch: rectangles, CW-wound rectangles,
random n-gons, near-circles above and below the 20-vertex / 0.15 coefficient-of-
variation gates for smooth radial normals, profiles with holes, extreme aspect
ratios that trip the cap-skipping veto, duplicate consecutive vertices that trip
`safe_earcut`'s sanitiser, and no/translation/rotation transforms. The assertion
is on the **raw `f32` bits** of every position and normal plus the index buffer,
and on error-message equality for the rejection paths.

Result: **4,000/4,000 bit-identical.** `cargo test -p ifc-lite-geometry --lib`
is 542/542 green.

---

## 2. The forward-value cross-check

The exam is void if the adjoints belong to a different function than the one the
kernel computes. Four independent checks, in increasing distance from the
harness:

| check | what it compares | result |
|---|---|---|
| 1 | dual instantiation's primal positions vs the `f64` instantiation's positions, bit-for-bit, 400 seeded cases | **identical**, and the volume deviation over the whole battery is **exactly 0.000e0** |
| 2 | instrumented forward volume vs `extrude_profile` + `apply_transform` -> production `Mesh` (f32) volume, world placement, 1200 points | max rel dev **3.0e-6** (family A) / **4.6e-6** (family B) |
| 3 | same, with the element in its local frame (placement zeroed) | max rel dev **1.7e-7** / **1.6e-7** |
| 4 | the whole shipping pipeline: an IFC4 STEP file with `IfcRectangleProfileDef` + `IfcExtrudedAreaSolid`, decoded and meshed by the wasm `GeometryProcessor` that the viewer and the clash CLI use, 24 points | vs in-process production f32: max rel dev **2.4e-8** (volume agrees to <= 1e-15 relative at 8 of 24 points; **exactly 1** point is bit-identical - corrected 2026-07-29 per the G4 review, the artifact is `kernel-cross-check.json`). Note this gap is **wasm-vs-native codegen**, not correct-vs-incorrect: both sides run the same Rust mesher. The byte-identity guarantee below is therefore established for the **native** build; the artifact users run is wasm; vs the instrumented f64 value: max rel dev **1.1e-6** |

Check 1 is the load-bearing one: it says the dual arithmetic *is* the mesher's
`f64` arithmetic, not an approximation of it.

Checks 2-4 quantify the one and only difference: **`Mesh` stores positions as
`f32`.** Production's volume is therefore a staircase function of the design
parameters - derivative zero almost everywhere, undefined on the steps - and
cannot be the differentiated quantity for anyone, by any method. What is
differentiated is the mesher's `f64` arithmetic, of which the production value
is the `f32` rounding. The size of that rounding is measured, not assumed:
**~3e-6 relative at a 30 m world placement, ~2e-7 in the local frame.** The gap
between those two numbers is the reason the codebase carries a local-frame
subsystem (`Mesh::origin`, #1114), and it is worth reading into the M3 record on
its own: the f32 vertex store is a larger error source than anything in the
gradient, by two orders of magnitude.

A fifth check pins the forward value to an independent closed form:
`det(shear) * xdim * ydim * depth`, matched to **2.188857e-13** relative worst
case across the **600 family-A points** (corrected 2026-07-29 by the G4
re-attestation: this sentence previously read "2e-13 across all 1,200 family-A
points", which was wrong twice - the battery's 1,200 points are 600 family A
plus 600 family B, and family B has a DIFFERENT oracle,
`det * depth * (A_outer + A_hole/3)`, whose battery-wide worst deviation is
**1.358479e-12**, 6x larger). The smoothness conclusion is unchanged and holds
for both families; only the point count and the tolerance were misstated.

---

## 3. Battery protocol

Everything below is fixed before the run and implemented in
`rust/geometry/src/b44_kernel_adjoint_tests.rs`.

### 3.1 Sampling

Seeded xorshift64\*, primary seed `20260727`, replications at seeds `7` and
`2026`. 200 points per family per seed.

**Family A - the rectangular-extrusion family (the exam), 10 parameters:**

| i | name | range |
|---|---|---|
| 0 | `xdim` | U(0.2, 6.0) m |
| 1 | `ydim` | U(0.2, 6.0) m |
| 2 | `depth` | U(0.2, 8.0) m |
| 3-5 | `dirx, diry, dirz` | half the draws axis-aligned (`0,0,±1`, including the negative-Z opening case that adds the `-depth` translation); half sheared, `|dirx|,|diry| ~ U(0.05, 0.6)`, `dirz ~ U(0.4, 1.2)`, clear of the mesher's `|d| < 0.001` axis-alignment threshold |
| 6-8 | `px, py, pz` | U(-30, 30), U(-30, 30), U(-10, 10) m |
| 9 | `theta` | U(-pi, pi) |

Both sides of the mesher's axis-alignment branch are exercised by construction.

**Family B - not part of the exam, added because a bet that only does its easy
half is a failed bet.** Family A plus a rectangular void in the profile
(`hcx, hcy, hw, hh`, 14 parameters), which routes the cap through earcut's
hole-bridging path and adds hole side walls.

### 3.2 Metric

Central differences, `h_i = 1e-5 * max(1, |x_i|)`, `fd_i = (f(x+h e_i) -
f(x-h e_i)) / (2 h_i)`. `1e-5` is near-optimal for central FD in doubles
(truncation `O(h^2)` against cancellation `O(eps |f| / h)`), and is the same
choice `scripts/moonshot/diff-spike/battery.mjs` documented.

Parameters are partitioned **a priori, from the mathematics**, into:

- **active** (`xdim, ydim, depth, dirx, diry, dirz` [+ `hw, hh`]): the functional
  genuinely depends on them. Graded by strict relative agreement:
  `|ad - fd| <= 1e-6 * max(|ad|, |fd|)`. No floors, no allowances.
- **invariant** (`px, py, pz, theta` [+ `hcx, hcy`]): the analytic gradient is
  exactly zero, because a rigid motion preserves the divergence functional of a
  closed surface and translating a void preserves area. Graded by
  `|ad_i| <= 1e-6 * ||ad||_inf`, i.e. *the analytic gradient must be zero to the
  relative scale of the gradient vector*, with the FD value recorded alongside.

A point passes iff every component passes its test.

**Why the partition, stated plainly.** `diff-spike/battery.mjs` scored 97.7% and
22 of its 23 failures were FD cancellation noise on components whose analytic
gradient was exactly zero; that analysis was done post hoc. **A relative
comparison against a finite difference cannot adjudicate a zero derivative, at
any tolerance, ever.** FD returns `eps * C / h` where `C` is the conditioning of
the computation; here the divergence sum over a mesh placed 30 m from the origin
has `C ~ |p|^3 * ntri >> f`, so the FD estimate of a true zero comes back at
1e-9..1e-7 absolute while the analytic value is ~1e-14. Grading that against a
1e-6 relative bar means grading the autodiff against noise. So the partition is
declared up front rather than discovered afterwards, and **both** numbers are
reported: the strict `diff-spike`-style metric applied to all components scores
**0/200 for a provably correct gradient**, which is the cleanest possible
demonstration that the metric, not the gradient, is what needed fixing. Applied
to active components only it scores **200/200**, matching the partitioned
verdict exactly.

Nothing in the partition can rescue a wrong gradient: a wrong active component
fails the strict relative test, and a wrong invariant component fails the
zero test.

---

## 4. Results

Primary run, family A, seed 20260727 (the pre-committed exam):

```
200 points x 10 params = 2000 components (1200 active, 800 invariant)
POINTS PASSED: 200/200 = 100.00%   [bar 95%]  -> PASS
  active components:    1200/1200 passed, max rel err 6.282e-8 (point 62 / dirx)
  invariant components:  800/800  passed, max |ad|/||ad||_inf 1.698e-14
                                          max |fd| (pure FD noise) 2.949e-8
  diff-spike metric, ACTIVE only: 200/200 = 100.00%
  diff-spike metric, ALL:           0/200 =   0.00%  (see 3.2)
forward x-check  dual primal vs generic-f64 mesher : max abs dev 0.000e0
forward x-check  vs PRODUCTION f32 mesh (world)    : max rel dev 2.968e-6
forward x-check  vs PRODUCTION f32 mesh (local frm): max rel dev 1.709e-7
forward x-check  vs closed-form oracle             : max rel dev 2.189e-13
```

All runs:

| run | points passed | active max rel err | verdict |
|---|---|---|---|
| A / seed 20260727 | 200/200 = 100.00% | 6.28e-8 | PASS |
| A / seed 7 | 200/200 = 100.00% | 5.86e-8 | PASS |
| A / seed 2026 | 200/200 = 100.00% | 4.35e-8 | PASS |
| B / seed 20260727 | 200/200 = 100.00% | 6.34e-7 | PASS |
| B / seed 7 | 200/200 = 100.00% | 6.18e-7 | PASS |
| B / seed 2026 | 199/200 = 99.50% | 1.26e-6 | PASS |

The single failing component in 8,400 (B / seed 2026, point 102, `dirx`):
`ad = -1.669700836e-2`, `fd = -1.669702943e-2`, absolute disagreement 2.1e-8.
The FD cancellation floor at that point is `~eps * C / h` with
`C ~ 1.6e5` and `h = 1e-5`, i.e. `~1e-6` absolute - fifty times the observed
disagreement. The finite difference is the side that is wrong, and the protocol
counts it as a failure anyway, inside the 5% budget, rather than widening the
criterion after seeing it.

Full output: `battery-report.txt`, `battery.json`,
`kernel-cross-check.json`.

---

## 5. A finding about the mesher, surfaced by the oracle

Family B's closed-form oracle is **not** the solid's volume. The emitted mesh
for a profile with a hole is **winding-inconsistent**: `create_side_walls`
orients every loop's walls outward from *that loop's own* interior, keyed off
the loop's signed area, so a hole's walls face into the solid instead of into
the void. Neither winding of the hole ring fixes it, because the sign flips with
the loop. The divergence functional of the raw mesh is therefore

```
depth * det(shear) * (A_outer + A_hole / 3)      not      depth * det(shear) * (A_outer - A_hole)
```

verified to 1e-12 and pinned by
`b44_holed_extrusion_is_winding_inconsistent`. Production compensates
downstream - `extrude_profile_watertight` runs `orient_mesh_outward` for exactly
this reason, and its comment already says raw assembly "closes as a 2-manifold
but with INCONSISTENT winding ... it breaks the divergence volume" - and the
exact CSG kernel re-orients. So this is a property of the raw mesher, not a
shipped defect, and it was **not** fixed here: this is a spike, and changing
production geometry to make a spike's oracle prettier is exactly the move the
pre-mortem warns about. It is written down so the next person who computes a
volume from `extrude_profile` output on a holed profile does not lose a day.

The family-B adjoint result is unaffected: the divergence functional of the
emitted mesh is a perfectly well-defined smooth function of the parameters, and
it is that function's gradient the battery grades.

---

## 6. What this does and does not license

**Licensed.** M3's adjoints reach the real geometry kernel for the
rectangular-extrusion family. The pre-committed kill criterion for M3 is not
triggered; the pre-committed downgrade to derivative-free optimization is not
invoked; "differentiable buildings" survives the exam it was given.

> **CORRECTION 2026-07-29 (G4 adversarial review, amendment 6 of the finishing
> plan, signed off by the gate-holder).** The sentence above is true and
> misleading, and this file is the one a reader on this branch sees. The exam
> B4.4 was given targets the **extrusion mesher**; M3's binary kill risk is the
> **CSG/void path**, which this bet did not attack (see section 6.1, which
> scopes it at two cycles). Section 3's own oracle shows the extrusion volume is
> a smooth closed form, so this exam could not have failed. **B4.4's PASS
> therefore neither triggers nor clears M3's binary gate. M3 is UNADJUDICATED**
> pending the Phase 5 CSG-adjoint bet. Nothing about the engineering result
> changes: the adjoints are real, they flow through the shipping mesher, and the
> byte-identity guard holds on the native build.

**Not licensed.**

1. **CSG.** The widened G2 finding was "adjoints through the CSG path". This
   bet did not attack that, because the pre-committed exam did not ask for it.
   The obstruction is materially different in kind and should be scoped as its
   own bet: the exact-arithmetic boolean kernel decides combinatorics with
   `bnum`-backed exact predicates on *derived* points (intersection vertices),
   so unlike ear clipping the connectivity decision and the coordinate
   computation are entangled - an intersection vertex's position is a rational
   function of the inputs *and* its existence is a sign test on the same
   quantities. A dual number would carry the coordinate derivative correctly,
   but the exact predicate tier operates on a fixed-width integer type that has
   no derivative slot, so the generic-over-scalar move does not transfer.
   Estimated cost: one cycle to determine whether the arrangement's derived
   points can be given derivatives without touching the predicate tier
   (plausible: predicates only need the primal), and a second to make the
   subtraction/union output stable enough that FD is meaningful across a cut.
2. **The rest of the mesher.** Faceted BREPs, swept disks, revolutions,
   tessellated face sets and the tapered/lofted extrusion path are untouched.
   The `GeomScalar`/`MeshSink` seam generalises to them mechanically, but
   "mechanically" is a claim, not a measurement.
3. **Anything about speed.** No optimisation was run through these adjoints.
   M3's interactivity claim still depends on M6b, per the finishing plan.
4. **Foreign data.** Instrument 6 does not apply to a numerical-analysis exam,
   but for the record: every parameter point here is authored by this program.

---

## 7. Reproducing

```bash
# battery + byte-identity guard + end-to-end wasm cross-check
node scripts/moonshot/b44-kernel-adjoint/run.mjs

# battery only (no wasm build needed)
node scripts/moonshot/b44-kernel-adjoint/run.mjs --no-wasm

# or directly
cd rust && cargo test -p ifc-lite-geometry --lib b44 -- --nocapture
cd rust && cargo test -p ifc-lite-geometry --lib byte_identity
```

The wasm leg needs `pnpm --filter @ifc-lite/geometry... build` first (it builds
`packages/wasm/pkg` from this working tree, so the cross-check runs against the
wasm compiled from the instrumented mesher, not a stale artifact).

Runtime: the battery is ~0.15 s in debug for all six runs (8,400 gradient
components, ~180,000 mesher evaluations). It runs inside
`cargo test --workspace` as a standing assertion, and its `assert!` against the
95% bar means a future kernel change that breaks the adjoints turns the required
`rust-tests` lane red - which is more than the B4.1 lane can currently say for
any other moonshot result (see B4.1's own correction note).

---

## 8. Test status, and every shortcut taken

**Green.**

- `cargo test -p ifc-lite-geometry --lib`: **542 passed, 0 failed** (was 536
  before; +6 from the byte-identity guard, the battery, the dual-primal
  bit-identity check and the winding pin).
- `cargo test --workspace --no-fail-fast`: green once fixtures are present.
  The one run that mattered most - `wall_opening_cut_regression` (7/7) and
  `csg_quality_regression` - drives real IFC walls with openings through
  `extrude_profile` on `ara3d/advanced_model.ifc` and passes.
- `cargo test -p ifc-lite-processing --test module_size_ratchet`: green.
  `extrusion.rs` fell 1078 -> 777 lines and `profile.rs` 431 -> 372; the two new
  production modules are 388 and 94 lines, both under the 400 limit. No
  allowlist row was added or raised (the allowlist lives in `rust/processing`,
  outside this bet's writable domain, and was deliberately not touched).
- `pnpm --filter @ifc-lite/geometry test`: **146 passed, 16 files**.

**Shortcuts, stated so nobody has to find them.**

1. **Ear-clipping connectivity is evaluated on the primal** and reused for the
   dual pass (section 1.3). Correct for a piecewise-smooth map; a point within
   `h` of a combinatorial seam would fail FD and is inside the 5% budget.
2. **Normals are not carried through the dual sink** (section 1.3). They do not
   enter the differentiated functional.
3. **The placement matrix is built in harness code**, because
   `parse_axis2_placement_3d` decodes IFC attributes (section 1.3).
4. **`cos`/`sin` are not on `GeomScalar`** - the mesher never needs them - so
   the placement's rotation is expanded to first order in `dual_cos_sin`. That
   is exact for `f64` and exact to first order for a forward-mode dual, which is
   all it carries.
5. **`f64::powi(2)` was rewritten as `d * d`** in
   `is_approximately_circular_profile` (there is no `powi` on `GeomScalar`).
   The byte-identity battery covers that function through the >= 20-vertex
   near-circle cases and reports bit equality, so the substitution is verified
   rather than assumed.
6. **Family B's oracle is the winding-inconsistent closed form**, not the solid
   volume (section 5). The underlying mesher behaviour was **not** fixed.
7. **`cargo clippy --workspace ... -- -D warnings`** (the CI command) fails in
   this worktree on `rust/core/src/georef.rs` and `rust/core/src/parser/
   scanner.rs` under the pinned nightly - files this bet never touched, and lint
   classes (`chunks_exact_to_as_chunks`, `collapsible_match`,
   `question_mark`) that already fire across the untouched tree. The one hit in
   new code, `scalar.rs`'s `chunks_exact_mut(3)`, is a verbatim-moved line from
   `extrusion.rs`. Nothing here changes that lane's state either way, but it was
   not verified green and should not be claimed as such.
8. **Foreign data: none.** See section 6.4.
