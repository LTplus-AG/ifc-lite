# Geometry kernel / CSG / CDT / weld / simplify / mesh review

Scope: `rust/geometry/src/kernel/**`, `rust/geometry/src/csg/**`, `rust/geometry/src/cdt.rs` + `cdt/**`, `rust/geometry/src/simplify/**`, `rust/geometry/src/facet_weld.rs`, `rust/geometry/src/mesh.rs` (+ its `#[path]` children `mesh_position_weld.rs` / `mesh_tjunction.rs` where relevant), and their test files. About 24k lines. No `unsafe` anywhere in scope, no rayon in scope, and no HashMap iteration order reaches output (every map that is iterated is a `BTreeMap`, and every `FxHashMap`/`HashSet` is used only for lookups or counts). Determinism hygiene is good. The problems are duplication, unit-denominated tolerances, and a few contract gaps.

## Summary
- **The exact-predicate stack is written three times.** The interval, fixed-width (`fixed_impl!`) and BigRational tiers each re-implement the LPI/TPI lambda, `orient2d_2i/3i`, the indirect orient2d/3d, `cmp_axis`/`cmp_lex` and `cmp_along`, about 600 lines of the most correctness-critical code. The cached-lambda tier adds a fourth copy of `orient2d`/`cmp_lex`. The tiers agree today because tests check them against each other, but every predicate change has to be made 3–4 times in lockstep.
- **The predicate cascade is assembled by hand in 6 places, and one copy has drifted.** `tritri::cmp_along` (`kernel/tritri.rs:85`) runs interval → fixed → BigRational but never calls `budget::note_escalation()`. Its escalations, which re-derive the full lambda, are invisible to the deterministic #1109 budget. Separately, `interner::intern` and `retriangulate::cmp_lex_v` duplicate the same cached-lambda lexicographic cascade.
- **Open-edge / watertightness counting is re-implemented about 30 times** (4 in production, about 26 in tests). The copies use incompatible definitions: weld grids of exact bits, 1e-6, 1e-4, 1e3 and 1e4, directed balance vs undirected `!= 2`, and different degenerate-edge rules. So "watertight" in one test does not mean the same as in another. `test_support::open_edges` already exists and almost nobody uses it.
- **Constants derived from `SNAP_GRID` are re-declared, not derived.** `fixed.rs` has its own `COARSE`/`FINE`/`FINE_OVER_COARSE`, `plane_weld.rs` has its own `Q`/`S16`/`S36`, and the `9.0e18` guard and the 2^-22 f32-ULP scale are repeated too. Change `SNAP_GRID` and the fixed tier silently falls through to BigRational on every predicate (about 1000× slower), and `exact_on_plane_weld` refuses every weld, which brings the crack family back.
- **Bug (LIKELY): the public `kernel::mesh_bridge::subtract` / `subtract_many` neither reset nor check the #1109 budget**, while `union`, `intersection` and `union_many` do both. After a trip on the same thread, `subtract` returns a partial arrangement as a normal `Mesh` / `BatchSubtract::Cut`. Production wrappers protect themselves; the fuzz target and external callers do not.
- **Several post-kernel tolerances are metre constants applied in caller units.** These are `consolidate`'s `POS_QUANT`, `CONFORM_TOL`, the seam grid, the plane test and the open-edge grids, plus `retriangulate_cleanup`'s "1 mm" floor. The classifier's "infinitesimal" probe step scales with absolute coordinate magnitude, not size: about 2 mm at 1 km and 19 mm at 10 km.
- **Many concepts have no single home**, so 3–20 hand-rolled copies exist with small drift: f64 vec3 math (tritri.rs alone defines it twice), triangle normals, point-in-mesh parity (3 algorithms), signed volume (6 copies with different reference points), vertex welds (8+), Mesh vertex readers (about 20, some bounds-checked and some not), `Mesh` struct literals (12+ sites listing every field), box fixtures (about 25), and the `DropAxis` → `(i, j)` mapping (6).
- **Performance:** the N-ary `union_all` path has none of the BVH / f64-cache acceleration the binary classifier got. Retriangulation recomputes I1024 lambdas from scratch (`fixed::point_to_f64`) even though the interner already caches them, and it clones constraint vectors and `ImplicitPoint`s per triangle.

## Findings

### KERNEL-1: The exact-predicate tiers (interval / fixed / BigRational / cached-lambda) are three to four hand-written copies of the same formulas
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - LPI lambda: `rust/geometry/src/kernel/interval.rs:121`, `rust/geometry/src/kernel/fixed.rs:104` (macro), `rust/geometry/src/kernel/rational.rs:96`
  - TPI lambda: `interval.rs:140`, `fixed.rs:121`, `rational.rs:155`
  - indirect_orient3d: `interval.rs:167`, `fixed.rs:228`, `rational.rs:133`
  - indirect_orient2d: `interval.rs:209`, `fixed.rs:176`, `rational.rs:222`
  - orient2d_2i: `interval.rs:312`, `fixed.rs:152`, `rational.rs:328`
  - orient2d_3i: `interval.rs:328`, `fixed.rs:164`, `rational.rs:344`, plus the cached copies `fixed.rs:393` (`orient2d_from_lam`) and `interval.rs:269` (`orient2d_from_lam_iv`)
  - cmp_axis / cmp_lex: `interval.rs:344/375`, `fixed.rs:186/210`, `rational.rs:358/387`, plus cached `fixed.rs:437` and `interval.rs:298`
  - cmp_along: `interval.rs:286`, `fixed.rs:219`, `rational.rs:290`, plus the dead `rational.rs:259` (`lpi_compare_along`)
  - det3 / cross / sub3 / sign_of helpers: `interval.rs:98-119`, `fixed.rs:54-95` and `318-335`, `rational.rs:14-67`
- What: Each tier spells out the same polynomial, just in a different number type (`RnInterval` with outward rounding, `FixedInt<K>` with checked ops returning `Option`, and `BigRational`). The "lambda of any point" helper has already drifted in totality:
  - `fixed::lambda_of` handles `Explicit` as `(coords, 1)`.
  - `interval::ilambda_of` (`interval.rs:238`) and `rational::lambda_of` (`rational.rs:270`) call `unreachable!` on `Explicit`.
  - So each tier needed a second wrapper (`ilambda_cached`, `lambda_or_explicit`).
- Why it matters: Every sign-convention fix has to land in 3–4 places at once. The LPI "minus is load-bearing" bug documented at `rational.rs:93` is exactly that class of fix. Today the oracle tests catch disagreement, but only for configurations the tests generate. The macro tier is also hard to read because helper names like `is_negative` resolve differently through inherent vs trait methods (`fixed_int/mod.rs:81-89`).
- Fix: Write each predicate once over a small ring trait, for example `trait ExactRing: Copy { fn sub(self,o)->Option<Self>; fn mul(..)->Option<Self>; fn add(..); fn sign(&self)->Option<Sign>; fn from_f64(..)->Option<Self>; }`:
  - `RnInterval`: `Some` always, with `sign` returning `None` on a straddle.
  - `FixedInt<K>`: the checked ops.
  - `BigRational`: `Some` always.
  Then `fn lpi_lambda<R: ExactRing>(l)`, `fn orient2d_2i<R>`, and so on live in one `kernel/predicate_core.rs`. `cached_lambda` / `IvLam` become `Lam<R>`. Monomorphisation keeps the exact same operation order, so the sign manifests (`manifest.rs:95`, `retriangulate.rs:931`) should not move. Re-pin them to prove it. Delete `rational::lpi_compare_along`.
- Effort: L

### KERNEL-2: Open-edge / closure counting has about 30 copies with incompatible definitions
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - Production:
    - `rust/geometry/src/csg/consolidate/conform/open_edges.rs:15` (quantized, undirected balance)
    - `rust/geometry/src/csg/consolidate.rs:527` (`count_open_boundary_edges_exact`, f32 bits)
    - `rust/geometry/src/csg/consolidate.rs:81` (1e3 wrapper)
    - `rust/geometry/src/router/voids/prism_cut/closure_checks.rs:78` (`directed_closed`, 0.1 mm directed)
  - In-scope tests:
    - `consolidate.rs:864` (`count_open_edges`, 1e6 grid)
    - `kernel/mesh_bridge_tests.rs:247` (`exact_open_edges`, directed bits) and `:623` (`open_edges`)
    - `kernel/nary_union_tests.rs:63` (`open_edges_3917`)
    - `kernel/issue_3913_sweep_tests.rs:157`
    - `facet_weld_scoped_tests.rs:26` (`directed_closed_mesh`, 1e-6 grid, BTreeMap)
    - `kernel/arrangement/tests.rs:169` (`edge_audit`)
  - Elsewhere in the crate: `test_support.rs:20` (the shared one, undirected `!= 2` on bits), `rect_fast.rs:520`, `processors/boolean/chain_cycle_tests.rs:281`, `processors/boolean/halfspace_cap_tests.rs:33`, `router/voids/prism_cut_tests.rs:102`, `router/voids/coaxial_union_tests.rs:91`.
  - Integration tests: `tests/issue_098_reveal_wall.rs:25`, `tests/issue_098_atomic_cut.rs:49`, `tests/issue_3353_boolean_tear.rs:123`, `tests/issue_3353_unrecovered_crosstab.rs:185`, `tests/issue_3353_sweep_261_classification_tear.rs:160`, `tests/issue_5313_thin_drop_tjunction.rs:44`, `tests/triangulation_invariance.rs:360`, `tests/halfspace_clip_cap_regression.rs:66`, `tests/issue_5362_fallback_disjoint_opening.rs:69`, `tests/touching_operand.rs:65`, `tests/issue_1007_real_opening_no_bridge.rs:166`, `tests/issue_3435_classify_probe.rs:118`, `tests/rect_param_parity.rs:60`, `tests/rect_fast_placement_frame_spike.rs:89`.
- What: The same half-edge pairing is written with different definitions:
  - Vertex key: exact f32 bits, round(x·1e3), round(x·1e4), round(x·1e6), round(x/1e-6), or a weld at 1e-4 first.
  - Count: signed directed balance vs undirected `count != 2`.
  - Degenerate edges: skipped vs counted.
  - Return type: `usize` vs `i64` vs `Result`.
- Why it matters: Watertightness is the main acceptance bar for this kernel. A regression test asserting `open_edges == 0` under a 1 mm weld can stay green while the production accept gate (0.1 mm, directed) rejects the same mesh, and the reverse also happens. The drift is a correctness risk, not just noise.
- Fix: One module (for example `geometry/src/topology_audit.rs`), exposed to integration tests through the existing `test-support` feature, with `EdgeKey::{ExactBits, Grid(scale)}`, `fn open_edge_count(mesh, key, Directed|Undirected) -> usize` and `fn directed_closed(mesh, key)`. Move `closure_checks::directed_closed` and `consolidate`'s two counters onto it, and make every test call it with an explicit, named mode.
- Effort: M

### KERNEL-3: Constants derived from `SNAP_GRID` are re-declared independently in four kernel files
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/kernel/mesh_bridge.rs:31` (`SNAP_GRID = 1/65536`)
  - `rust/geometry/src/kernel/fixed.rs:244-249` (`COARSE = 65_536.0`, `FINE = 2^36`, `FINE_OVER_COARSE = 1<<20`)
  - `rust/geometry/src/kernel/plane_weld.rs:361-363` (`Q = 2^20`, `S16 = 65_536.0`, `S36 = 2^36`)
  - the `9.0e18` exact-i64 guard at `fixed.rs:48` and `plane_weld.rs:384`
  - the `2^20` direction quantisation at `kernel/tritri.rs:66` and the `2^10` one at `kernel/coplanar.rs:83` (both chosen so results stay on the fine grid)
  - the probe step `2^-20` at `kernel/arrangement/classify.rs:283`, `classify.rs:438` and `kernel/arrangement/boolean.rs:111`
- What: The fixed tier only accepts coordinates on the `1/COARSE` or `1/FINE` grid. `plane_weld` emits vertices on the `1/S36` grid. Both grids are defined by `SNAP_GRID` and the 2^20 α/β quantisation, but nothing ties the literals to `SNAP_GRID`; the comments say "2^16 = 1/SNAP_GRID".
- Why it matters: Changing `SNAP_GRID` (it is the documented tuning knob, #2684) compiles cleanly, keeps every sign correct, and quietly:
  1. makes every `gi()` fail, so every implicit predicate escalates to BigRational (a perf cliff of about 1000×, enough to trip the budget everywhere);
  2. makes `exact_on_plane_weld` refuse every weld (`s.fract() != 0`), which re-opens the crack family the weld fixes.

  The 2^10 vs 2^20 choice in `coplanar.rs` depends on the grid bit budget too (see its doc).
- Fix: Put the grid in one module (`kernel/grid.rs`, or extend `rust/geometry/src/grid.rs`): `pub const SNAP_EXP: i32 = 16; pub const ALPHA_EXP: i32 = 20; SNAP_SCALE = 2^SNAP_EXP; FINE_SCALE = 2^(SNAP_EXP+ALPHA_EXP); SNAP_GRID = 1/SNAP_SCALE; EXACT_I64_GUARD = 9.0e18`. Derive every site from it, and add `const_assert!`s for the bit-budget arguments in the `coplanar.rs:72` and `fixed.rs:21` docs.
- Effort: S

### KERNEL-4: The predicate cascade is composed by hand in six places; the tri-tri copy skips the #1109 budget
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED (duplication); LIKELY (budget impact)
- Where:
  - `rust/geometry/src/kernel/predicates.rs:21-108` (with `note_escalation`)
  - `rust/geometry/src/kernel/tritri.rs:85-93` (`cmp_along`, no `note_escalation`)
  - `rust/geometry/src/kernel/interner.rs:54-70` (cached lex cascade)
  - `rust/geometry/src/kernel/retriangulate.rs:63-74` (`cmp_lex_v`, the same cached lex cascade)
  - `rust/geometry/src/kernel/retriangulate.rs:39-57` (`orient2d_v`)
  - `rust/geometry/src/kernel/arrangement/mod.rs:107` (`orient2d_end`)
- What:
  - `tritri::cmp_along` falls through to `fixed::cmp_along`, which re-derives both lambdas via `lambda_of`. That is the expensive recompute the budget is calibrated to count (`budget.rs:308-324`). It never calls `note_escalation()`. The budget docs list only the cached-lambda tiers as deliberate exemptions; `cmp_along` is not one of them.
  - The interner's binary-search comparator and `cmp_lex_v` are the same three-tier code (iv → I512 lambda → ImplicitPoint).
- Why it matters: A pathological near-coplanar host can spend its time in tri-tri ordering escalations without ever tripping the deterministic per-boolean or per-element cap, which is the #1109 hang the budget exists to prevent. Copy-pasted cascades also drift on which tiers they try.
- Fix: Put `cmp_along` in `predicates.rs` next to the others and call `note_escalation()` there. Adding it changes trip points, so re-pin the budget calibration and manifests. Add one `cmp_lex_cached(iv_a, lam_a, pt_a, iv_b, lam_b, pt_b)` and one `orient2d_cached(..)` in `predicates.rs`, and have the interner, `retriangulate` and `arrangement` call them.
- Effort: S

### KERNEL-5: f64 vec3 / triangle-normal helpers are re-declared across the kernel (twice in one file)
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/kernel/tritri.rs:42-52` (`sub_f64`, `cross_f64`, `plane_normal`) and again at `tritri.rs:155-169` (`ti_sub`, `ti_cross`, `ti_dot`, `ti_normal`)
  - `kernel/arrangement/classify.rs:17-22,85` (`cross3`, `dot3`, `sub_f64`)
  - `kernel/coplanar.rs:28` (`plane_normal`)
  - `kernel/retriangulate.rs:110-118` (closure)
  - `kernel/retriangulate_cleanup.rs:51-53`
  - `kernel/mesh_bridge.rs:70-90` (`face_plane`)
  - `kernel/plane_weld.rs:260-268` and `:367` (`dot` closure)
  - `kernel/signed_volume.rs:25-36`
  - `facet_weld.rs:123-136` (`tri_normal`)
  - `simplify/cavities.rs:~135-140`
  - `simplify/ray_parity.rs:~45-75`
  - `csg/normals.rs:66-68`
  - `csg/consolidate.rs:208-212`
  - `kernel/arrangement/boolean.rs:133`
  - outside scope: `clash_contact_axes.rs:52-81`, `router/voids/prism_cut.rs:222-238`
- What: The same FMA-free cross, dot and sub operations are inlined in 15+ places. The `+Z` fallback for a degenerate normal is re-decided at each site (`mesh_bridge.rs:89`, `csg/mod.rs:107`, `csg/normals.rs:83`).
- Why it matters: Determinism depends on an identical operation order everywhere. A shared helper makes that order a single fact instead of 15 that must be kept equal by hand. `tritri.rs` carrying two copies 100 lines apart shows the cost.
- Fix: `kernel/vec3.rs` (or crate-level `geom3d.rs` next to the existing `geom2d.rs`) with `sub`, `cross`, `dot`, `tri_normal_raw`, `tri_unit_normal_or_z` written in today's exact operation order. Migrate one file per PR and keep the manifests byte-identical. Ban `mul_add` there (see KERNEL-34).
- Effort: M

### KERNEL-6: The arrangement classifier duplicates its own internals, and the N-ary path drifted from the binary one
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Probe-step logic ×3: `rust/geometry/src/kernel/arrangement/classify.rs:272` (`solid_side`), `classify.rs:432` (`BComponents::solid_side`), `rust/geometry/src/kernel/arrangement/boolean.rs:106` (`offset_point`)
  - Regime-2 keep table ×2: `classify.rs:497-501` (`on_interface_keep`) and `classify.rs:586-590` (inline closure)
  - Centroid and normal ×2: `classify.rs:89/98` and `boolean.rs:120/133` (`centroid_multi`, `tri_normal_multi`)
  - Vid materialisation ×2: `classify.rs:59` (`to_f64_pt`, with an f64 cache and the cached-lambda fast path) and `boolean.rs:143` (`point_via_interner`, neither)
  - AABB build: `classify.rs:327-343` duplicates `kernel/broadphase.rs:116` (`tris_aabb`)
  - Slab test: `classify.rs:362` (`ray_may_hit`) duplicates `kernel/broadphase.rs:62` (`seg_hits_aabb`); they differ in the `d == 0` vs `<= MIN_POSITIVE` threshold and in padding
  - Pair loop and constraint build ×2: `kernel/arrangement/mod.rs:185-232` (`arrange`) and `:289-339` (`arrange_many`)
- What: The binary and N-ary paths each have their own copy of every step, and the N-ary copies lack the later optimisations (f64 cache, `point_to_f64_from_lam`, BVH).
- Why it matters: A classification fix applied to one regime table or probe silently skips the other. The #4439 / #3353 fixes in this module already needed care for exactly this reason.
- Fix: `fn regime2_keep(op, plus, minus) -> bool`; one `probe_points(c, dir, step)`; make `MultiArrangement` hold the same `f64_cache` and reuse `to_f64_pt` through a small trait over `{Arrangement, MultiArrangement}`; implement `arrange` as `arrange_many(&[a, b])` restricted to the A×B pair, or share `accumulate_pair()` and `build_constraints()`; reuse `tris_aabb` and `seg_hits_aabb(.., pad=0)`.
- Effort: M

### KERNEL-7: Three point-in-closed-mesh parity algorithms with different robustness rules
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/kernel/arrangement/ray_parity.rs:135` (`point_inside`: exact `orient3d`, one fixed ray, grazing hits silently dropped), plus the BVH variant at `classify.rs:35`
  - `rust/geometry/src/simplify/ray_parity.rs:1` (`point_enclosed`: float Möller–Trumbore, 3 jittered axis rays, grazes detected and the ray discarded, 2-of-3 vote)
  - linear-scan callers: `boolean.rs:76`, `classify.rs:400`
- What: Two independent inside/outside tests exist. The exact one never detects a graze (an exact hit through a shared edge drops both triangles and flips parity; see KERNEL-29). The float one does detect grazes but is tolerance-based (`BARY_EPS = 1e-9`, `t_eps = 1e-9·scale`, `det < 1e-16`).
- Why it matters: Two definitions of "inside" in one crate. The simplify cavity pass could reuse the exact, deterministic kernel test with a BVH. The kernel could adopt simplify's graze-detect-and-retry idea.
- Fix: Promote `point_inside` / `point_inside_bvh` to a `pub(crate)` `kernel::inside` module that returns `Option<bool>` (`None` on an exact graze) and retries with a second fixed direction. Use it from `simplify::cavities` and delete `simplify/ray_parity.rs`.
- Effort: M

### KERNEL-8: Signed volume is implemented six-plus times, with drifted reference points and snapping
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/kernel/signed_volume.rs:25-121` (Tri; AABB-centre reference)
  - `rust/geometry/src/kernel/mesh_volume.rs:74` (public `mesh_volume`, snaps to `SNAP_GRID` via `mesh_to_tris` first)
  - `rust/geometry/src/router/voids/geom.rs:331-360` (Mesh, unsnapped, bounds-centre reference)
  - `rust/geometry/src/router/voids/frame_snap.rs:190` (`enclosed_volume`, bounds centre)
  - `rust/geometry/src/world_frame_fixture.rs:125` (about the world origin)
  - tests: `facet_weld_scoped_tests.rs:52` (origin), `kernel/mesh_bridge_tests.rs:11`, `kernel/arrangement/tests.rs:16`, `csg/csg_tests.rs:147`, `router/frame_parts.rs:256`
- What:
  - The public `mesh_volume` quantises every coordinate to 2^-16 before summing (documented in its tests as a "noise floor"). The router's `mesh_signed_volume` reads raw f32.
  - The fixture and test copies sum about the world origin, which `signed_volume.rs:121` (#198779) shows flips the sign for far-from-origin open meshes.
- Why it matters: The crate has two documented "volume" answers for the same mesh, and test oracles that are less robust than the production code they check.
- Fix: One `Mesh::signed_volume_about(&self, o)` plus `Mesh::volume_reference()`, built on `kernel::signed_volume::tetra_volume6`. `mesh_volume` should not snap, or should say in its name that it measures the kernel's view. Tests call the shared helper.
- Effort: S

### KERNEL-9: Vertex welding / position dedup is implemented 8+ times
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/facet_weld.rs:171-182` (BTreeMap) and `facet_weld.rs:694-707` (FxHashMap): the same dedup twice in one file
  - `rust/geometry/src/mesh_position_weld.rs:18` (`weld_impl`)
  - `rust/geometry/src/mesh_weld.rs:182` (`weld_indexed`)
  - `rust/geometry/src/simplify/cavities.rs:~73-90` (comment says "same quantization contract as `mesh::weld_impl`", i.e. a copy)
  - `rust/geometry/src/simplify/cluster.rs:~28-37` (uses `floor` cells where the others use `round`)
  - `rust/geometry/src/csg/consolidate/ring_ops.rs:43` (2D sequential)
  - outside scope: `rust/processing/src/geometry_export.rs:287`, `rust/geometry/src/router/voids/prism_cut/vertex_dedup.rs`
  - `facet_weld.rs:106` (`snap_grid`) is the same function as `kernel/mesh_bridge.rs:34` (`snap`)
- What: Every copy computes `(v * inv).round() as i64` keys plus a first-wins remap, with small differences: round vs floor, f32 vs f64 key arithmetic, `max(f32::MIN_POSITIVE)` guards, and BTreeMap vs FxHashMap.
- Why it matters: A key-rounding bug or a performance fix (for example the thread-local scratch in `mesh_weld`) has to be found and repeated in each copy.
- Fix: `pub(crate) fn quant_key3(p:[f64;3], inv_cell:f64) -> [i64;3]` and `struct PositionDedup { fn canon(&mut self, p) -> u32 }` in `grid.rs`. Make `kernel::mesh_bridge::snap` `pub(crate)` and reuse it in `facet_weld`.
- Effort: M

### KERNEL-10: `Mesh` has no f64 vertex/triangle accessor, so about 20 ad-hoc readers exist and only some check bounds
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/csg/mod.rs:474-493` (jscpd clone with `csg/normals.rs:44-63` and `router/voids/aabb_clip.rs:88-104`)
  - `csg/consolidate.rs:186-206` (checked) vs `csg/consolidate.rs:90-113` (`count_spike_triangles`, unchecked)
  - `csg/consolidate/conform/open_edges.rs:21` (unchecked), `csg/consolidate.rs:527` (unchecked)
  - `mesh.rs:578` (checked) and `mesh.rs:857` (`clip_triangles_to_aabb::inside`, unchecked)
  - `kernel/mesh_bridge.rs:49` (checked)
  - `facet_weld.rs:157,682`
  - `simplify/cavities.rs:~120`, `simplify/cluster.rs:~31`
  - `router/voids/geom.rs:368` (`mesh_vertex`), `mesh_tjunction.rs` (`pos_of`)
- What: There are already two private helpers (`mesh_vertex`, `tjunction::pos_of`) besides the inline copies. Some readers skip out-of-range triangles; others index `positions[i*3]` directly.
- Why it matters: An out-of-range index (malformed IFC, #1500-class input) panics, which is a worker abort under `panic = "abort"`. Whether it panics depends on which copy a code path reaches (see KERNEL-28).
- Fix: `impl Mesh { fn position_f64(&self, i: u32) -> Option<[f64;3]>; fn triangles_f64(&self) -> impl Iterator<Item=(usize,[[f64;3];3])> }`, which skips invalid triangles, and use it everywhere.
- Effort: M

### KERNEL-11: `Mesh` is built with full struct literals at 12+ sites outside `mesh.rs`
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/mesh.rs:229,245,295` (in-file)
  - `rust/wasm-bindings/src/zero_copy/mesh.rs:~452-463`
  - `rust/processing/src/style/indexed_colour.rs:~200-212, 231-243`
  - `rust/geometry/src/csg_capture.rs:~181-192`
  - `rust/geometry/src/processors/structural_face.rs:~33-44`
  - `processors/swept/revolved.rs:~246-257`
  - `processors/brep/faceted.rs:~356-367`
  - `processors/tessellated/mesh_build.rs:~143-154, 232-243`
  - `processors/surface.rs:~122-133`
- What: Each site lists all 10 fields, including `welded_in_object_frame: false, plane_tags: None`.
- Why it matters: `plane_tags` (#3914) and `welded_in_object_frame` (#4122) were each added by editing every literal. The next field will be too, and a missed site is a compile error only if nobody uses `..`. A wrong default (for example copying `local_bounds` from a different mesh) is easy.
- Fix: `Mesh::from_buffers(positions, normals, indices) -> Mesh`, or `Mesh { positions, normals, indices, ..Mesh::new() }`. Keep `rebuilt_like` for frame-carrying rebuilds.
- Effort: S

### KERNEL-12: Degenerate-triangle criteria are scattered, with different thresholds and passes
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/mesh.rs:573` (`drop_degenerate_triangles`: bit-identical pair or aspect > 1e5)
  - `mesh.rs:~743` (`drop_thin_triangles`: height < h_eps)
  - `mesh.rs:~817` (`clean_degenerate`: height < `SNAP_GRID`)
  - `csg/consolidate.rs:43` (`tri_is_needle`: min_edge < floor_pow2(max)·2^-13)
  - `csg/consolidate.rs:90` (spike: ratio > 50 and min > 1e-6)
  - `facet_weld.rs:494` (aspect > 8 and min > 1e-9)
  - `cdt.rs:1221` (`tri_is_skinny`: aspect > 7 or angle < 22°, e0 ≤ 1e-15)
  - `csg/mod.rs:145` (`Triangle::is_degenerate(eps)`, test-only)
  - `csg/consolidate.rs:213` (`len < 1e-10`)
  - `kernel/mesh_bridge.rs:84` (`len > 0`)
  - `simplify/mod.rs:118-119` runs both `drop_degenerate_triangles()` and `clean_degenerate()` back to back
- What: There are at least 9 notions of "degenerate". Some are absolute and unit-dependent (1e-6, 1e-9, 1e-10, 1e-15, `SNAP_GRID`); some are relative.
- Why it matters: Whether a sliver survives depends on which pipeline path it took. Consolidation drops it, `rebuild` bisects it, the router height-filters it. Some of these interactions are hard-won (#4698, #5313), so this is a "name and document them in one place" fix, not a "merge them" fix.
- Fix: A `geometry/src/degeneracy.rs` holding the named predicates (`is_needle_rel`, `is_thin_abs`, `aspect`), each documenting its unit and its callers. `simplify` should call one of them, not two.
- Effort: M

### KERNEL-13: Test fixtures are copy-pasted: `boxed()` ×7 verbatim, about 25 box builders, `mesh_of` twice in one file
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `boxed`: `rust/geometry/src/kernel/arrangement/issue_3353_vid_census_tests.rs:309`, `kernel/nary_union_tests.rs:15`, `kernel/issue_3913_sweep_tests.rs:105`, `kernel/mesh_bridge_tests.rs:585`, `rust/geometry/tests/issue_3353_near_coplanar_rotated_overlap.rs:68`, `tests/issue_3353_sweep_261_classification_tear.rs:119`, `tests/issue_3353_unrecovered_crosstab.rs:135`
  - Box builders: `csg/consolidate.rs:835` (`axis_box`), `simplify/mod.rs:131` (`soup_box`), `kernel/arrangement/tests.rs:11` (`cube`), `kernel/arrangement/boolean.rs:281` (`box_mesh`, shipped as pub prod API), `simplify/boxify.rs:28`, plus about 15 more in `tests/` and other modules
  - `mesh_of` at `kernel/mesh_bridge_tests.rs:169` and `:267` (same file)
  - `mesh_from_tris` at `mesh_tests.rs:8` and `facet_weld_scoped_tests.rs:277`
  - `SimplifyOptions {..}` literal ×6 in `simplify/mod.rs` tests
- What: The copies carry comments like "Verbatim copy of … (itself a copy of …) — each fixture keeps its own per that family's documented convention".
- Why it matters: The reason given is that the corner and face order is load-bearing. A shared helper preserves that order better than seven copies do. The real risk is one copy being "fixed" while the others are not, so two regression families pin different fixtures under the same name.
- Fix: Extend `rust/geometry/src/test_support.rs` (already behind `cfg(test)` plus the `test-support` feature) with `boxed(min, size, rot)`, `mesh_of(vs, fs)`, `mesh_from_tris`, `open_edges(mode)` (see KERNEL-2) and `signed_volume`. Add a doc line pinning the corner and face order. Move `box_mesh` / `cube_mesh` behind `cfg(any(test, feature = "test-support"))`.
- Effort: M

### KERNEL-14: CDT emit / PSLG setup and BVH traversal are copy-pasted (jscpd-confirmed)
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/cdt.rs:1284` (`Cdt::emit`), `cdt.rs:1440` (`triangulate_pslg`), `cdt.rs:1475` (`triangulate_pslg_with_progress`): the same "skip dead or super, orient CCW, push" loop
  - `cdt.rs:1376` vs `cdt.rs:1406` (`triangulate_refined` vs `triangulate_constrained`: identical ring → PSLG → emit → Point2)
  - `rust/geometry/src/kernel/broadphase.rs:178/201/221` (three recursive `descend*`)
  - `rust/geometry/src/kernel/broadphase/bounded.rs:10` and `:55` (iterative copies), plus `broadphase/nearest.rs`
- What: Each copy differs only in the node predicate (or, for CDT, in whether refinement runs).
- Fix: `Cdt::emit_hull(&self, keep_upto, progress)` shared by the three emitters; `fn triangulate_rings(outer, holes, refine: bool)`; `Bvh::walk(&self, pred: impl Fn(&Aabb)->bool, out)` plus `walk_bounded(pred, budget)`.
- Effort: S

### KERNEL-15: The retriangulation f64 prefilter (box plus margin) is hand-copied four times
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/kernel/retriangulate.rs:319-321` (`aabb_excludes`)
  - `retriangulate.rs:348` (`tri_aabb_disjoint`)
  - `retriangulate.rs:490-491` (earcut, inline)
  - `rust/geometry/src/kernel/retriangulate_recover.rs:407-408` (`enforce_constraint`, inline)
  - Segment-box construction ×2: `retriangulate_recover.rs:~78-91` (`ab_box`) and `:~384-398` (`seg_box`)
- What: All copies use the margin `1e-6 + |x|·1e-9`, but they compute the magnitude term differently:
  - `aabb_excludes` uses the point's per-axis magnitude.
  - `tri_aabb_disjoint` and earcut use `max(|bx.max_x|, |bx.max_y|, …)` and ignore the minimum corner.
  - `enforce_constraint` uses the vertex's magnitude.
  All are documented as "the SAME conservative margin". The absolute `1e-6` is in caller units.
- Why it matters: The prefilter's soundness argument (never skip a triangle the exact test would accept) is stated once but implemented four ways. Today the slack is comfortably sound (f64 image error is about 1e-16·|x|), so this is maintenance risk, not a live bug.
- Fix: `struct Prefilter2d { fn box_of(&[Option<[f64;2]>]) -> Option<Box2>; fn excludes(box, p) -> bool; fn disjoint(box, box) -> bool }` with one `margin(mag)` function. Also back `coord2d_cached` with the interner's cached lambda (see KERNEL-24).
- Effort: S

### KERNEL-16: 2D proper-crossing and point-in-triangle predicates exist in 5+ variants
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Proper crossing: `rust/geometry/src/kernel/arrangement/mod.rs:115` (`segments_cross`), `kernel/coplanar.rs:46` (`seg_seg_cross`), `kernel/retriangulate_recover.rs:~50-71` (`tri_crosses`) and `~283-297` (`find_entry`), `rust/geometry/src/cdt/predicates.rs:28` (`segments_properly_cross`), `rust/geometry/src/geom2d.rs:105` (`segments_intersect`, closed variant)
  - Point in triangle: `kernel/coplanar.rs:39` (`point_in_tri`), `kernel/arrangement/classify.rs:120` (`point_in_tri_proj`), `kernel/retriangulate.rs:238` (`locate`) and `:426` (`strictly_outside`)
  - Collinear "between": `retriangulate_recover.rs:252` and `cdt/predicates.rs:22`
- What: The same four-orientation formula appears over `Sign` (kernel) and over `i32` (CDT/geom2d).
- Fix: `fn proper_cross(s1,s2,s3,s4: Sign) -> bool` and `fn closed_contains(edge_signs: [Sign;3], w0) -> Locate` in `kernel/mod.rs`, each callable with any orient closure.
- Effort: S

### KERNEL-17: Bug: public `mesh_bridge::subtract` / `subtract_many` do not reset or check the #1109 budget
- Category: Bug
- Severity: Medium
- Confidence: LIKELY
- Where:
  - `rust/geometry/src/kernel/mesh_bridge.rs:150` (`subtract`), `:163` (`subtract_with_change`), `:213` (`subtract_many`)
  - Compare `union_with_conformity` (`:316`, `:329`), `intersection_tris` (`:354`, `:361`), `nary_union.rs:108-113`
  - Exposed caller: `rust/geometry/fuzz/fuzz_targets/kernel_subtract.rs:7`
- What:
  - `union`, `intersection` and `union_many` call `budget::begin()` and return empty when `budget::tripped()`.
  - `subtract` and `subtract_many` do neither. They rely on the caller (`csg::subtract_mesh` at `csg/mod.rs:354/363`, `group_cut.rs:162/164`).
  - `arrange` and `retriangulate_each` `break` as soon as `tripped()` is true.
- Failure scenario: Any direct caller on a thread whose `COUNT` was left over cap by an earlier boolean gets a truncated arrangement back. `tris_a` is cut short, `unrecovered` can be 0, and `difference_all` returns `Some`, so the result is `BatchSubtract::Cut(partial)` or a `Mesh` missing faces, reported as success. The fuzz target runs `subtract` repeatedly on one thread, so after the first trip every later input is "tested" against an empty or partial result. Production wrappers are safe today.
- Fix: Make the public entry points self-contained: call `budget::begin()` and return `Mesh::new()` / `BatchSubtract::Nonconforming` (or a new `BudgetTripped` variant) when tripped, as `union` does. Keep the `pub(crate)` `*_with_*` variants caller-managed and document that.
- Effort: S

### KERNEL-18: The classifier's "infinitesimal" probe step scales with absolute coordinate magnitude, not operand size
- Category: Quirk
- Severity: Medium
- Confidence: SUSPECT
- Where:
  - `rust/geometry/src/kernel/arrangement/classify.rs:283` and `:438`
  - `rust/geometry/src/kernel/arrangement/boolean.rs:111`
  - `rust/geometry/src/kernel/arrangement/ray_parity.rs:37` (`operand_extent = 2·max|coord| + 1`)
- What: `step = operand_extent · 2^-20`. The comment says this is "~µm at building scale", which only holds within a few metres of the origin. In metres the step is about 0.2 mm at 100 m, about 1.9 mm at 1 km, and about 19 mm at 10 km. The kernel runs in the world frame on paths that are not RTC-rebased below 1 km (`rust/AGENTS.md`), and on file-unit meshes.
- Failure scenario: In regime 2 (`solid_side` / `BComponents::solid_side`) and the N-ary union's `offset_point`, a sub-triangle on a shared interface 800 m from origin probes ±1.5 mm. If the other operand has a feature thinner than that (a 1 mm reveal or plate gap), the probe lands on the far side, `op_plus == op_minus` becomes false or true incorrectly, and keep/drop flips. `csg/world_frame_tests.rs` pins a 2 mm recess at 10 km, where the step (19 mm) is already ten times the feature.
- Fix: Size the step from the operand's extent (AABB diagonal) rather than its distance from the origin, floored at the near band (`NearBand::radius`). For example `step = max(8·NEAR_BAND_FLOOR, diag·2^-20)`. Re-pin the manifests.
- Effort: S

### KERNEL-19: Consolidation's absolute tolerances are metre constants applied in caller (file) units
- Category: Quirk
- Severity: Medium
- Confidence: SUSPECT
- Where:
  - `rust/geometry/src/csg/consolidate.rs:166` (`POS_QUANT = 1e6`, i.e. 1 µm), `:213` (`1e-10`), `:82` and `:406/522` (open-edge grids 1e3 / 1e4), `:108` (spike `1e-6`)
  - `rust/geometry/src/csg/consolidate/conform.rs:38` (`CONFORM_TOL = 1e-4`), `:65/77` (seam grid 1e4), `:286` (plane test `1e-5`)
  - `rust/geometry/src/csg/consolidate/ring_ops.rs:240` (`NOISE_AREA`)
  - Entry with file units: `rust/geometry/src/processors/boolean/single_cutter_gate.rs:81` (`ClippingProcessor::with_unit_scale`)
- What: `consolidate` runs on file-unit operands on the `processors/boolean` path. Only the ring-width gate is converted through `length_unit_scale` (#4744). In a millimetre file:
  - the seam-conform tolerance is 0.1 µm;
  - the seam lattice is 0.1 µm;
  - the on-plane test is 10 nm;
  - "1 mm" open-edge detection is 1 µm.
  These are at or below the f32 ULP of mm coordinates (about 1 µm at 10 m, which is 1e4 mm).
- Failure scenario: On a mm-authored file, the cross-bucket T-junction conform (#217 / #098) can essentially never match a seam candidate, because the seam grid and the plane test are finer than f32 noise. The hairline-crack repair silently does nothing for those files, while the same geometry in a metre file gets repaired.
- Fix: Pass `length_unit_scale` into `PlanBucket` and the conform pass, and express every absolute constant in metres converted to caller units (`CONFORM_TOL_M / length_unit_scale`). Same treatment for `count_open_boundary_edges_at` scales. Measure on a mm corpus file first, as `plane_eps.rs:69-74` asks for its own floor.
- Effort: M

### KERNEL-20: `Mesh::merge` / `Mesh::clear` do not uphold the metadata-invalidation contract the field docs require
- Category: Quirk
- Severity: Medium
- Confidence: LIKELY
- Where:
  - `rust/geometry/src/mesh.rs:363` (`merge`), `mesh.rs:693` (`clear`), the contract in the `plane_tags` field doc (`mesh.rs:91-102`)
  - Callers that keep the left operand's metadata: `rust/geometry/src/csg/union.rs:51-53,82-84` (fallback `mesh_a.clone().merge(b)`), `simplify/mod.rs:107` (`out = mesh.clone()` before in-place cavity removal)
- What: The `plane_tags` doc says every merge or transform that changes triangle count MUST leave `plane_tags` as `None`.
  - `merge` appends triangles but leaves `plane_tags`, `instance_meta`, `local_bounds` and `welded_in_object_frame` from `self` untouched.
  - `clear` resets `instance_meta`, `local_bounds` and `local_to_world`, but not `origin`, `plane_tags` or `welded_in_object_frame`.
- Failure scenario:
  - The union fallback returns `mesh_a`'s `local_bounds` (no longer a superset of the merged extent) and `instance_meta` (the hazard `rebuilt_like` documents: the instancing collator dedups a changed mesh against its pristine sibling).
  - A cleared and reused mesh keeps its old `origin`, so freshly added absolute vertices are interpreted relative to the stale origin.
  - `plane_tags` staleness is currently masked by `tag_for`'s length check (`plane_merge.rs:78`).
- Fix: In `merge`, set `plane_tags = None`, `instance_meta = None`, `welded_in_object_frame &= other.welded…`, and either union or clear `local_bounds`. In `clear`, reset every field to `Mesh::new()` defaults (`*self = Mesh { positions, normals, indices, ..Mesh::new() }` to keep capacity).
- Effort: S

### KERNEL-21: N-ary `union_all` lacks the BVH and f64 cache the binary classifier got, and the A-side probes are linear
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/kernel/arrangement/boolean.rs:61-99` (per sub-triangle, per other mesh, linear `point_inside`)
  - `boolean.rs:120-150` (`point_via_interner` recomputes the I1024 lambda up to 3× per vertex use: centroid, normal, output)
  - `rust/geometry/src/kernel/arrangement/classify.rs:400-428` (`BComponents::inside` and `surface_normal`: linear over each component)
  - `classify.rs:216-224` (`near_on_surface_normal` rebuilds a `NearBand` over the whole component for every A sub-triangle, where the B side hoists `a_band` and uses the BVH at `:235`)
- What: The binary B-side path was optimised (BVH, hoisted band, `f64_cache`, `point_to_f64_from_lam`). The A side and the N-ary union were not. For A side that is O(|subA|·|B|) per probe kind; for the union it is O(subtris·Σmeshes).
- Why it matters: The #960 roof-cutter unions and union-heavy elements pay quadratic cost, and `union_many` retries up to 6 arrangements (`nary_union.rs:150`).
- Fix: Build one `Bvh` per component or mesh and reuse `point_inside_bvh` / `c_on_or_near_a`. Give `MultiArrangement` the `f64_cache` (see KERNEL-6). Hoist the band per component.
- Effort: M

### KERNEL-22: Public kernel surface is wide (semver-checked crate) and carries dead or test-only pub items
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/kernel/mod.rs:17-41` (`pub mod predicates`, `rational`, `interval`, `fixed`, `interner`, `tritri`, `coplanar`, `broadphase`, `arrangement`, `retriangulate`, `manifest`, …)
  - Dead pub items: `kernel/rational.rs:259` (`lpi_compare_along`), `mesh.rs:311` (`Mesh::from_triangle`), `mesh.rs:416` (`Mesh::merge_all`)
  - Test-only pub items: `csg/mod.rs:208` (`ClippingProcessor::clip_triangle`), `csg/mod.rs:145` (`Triangle::is_degenerate`), `kernel/arrangement/boolean.rs:281/295` (`box_mesh` / `cube_mesh`)
  - `type Tri = [[f64;3];3]` declared three times: `kernel/coplanar.rs:21`, `kernel/arrangement/mod.rs:43`, `kernel/broadphase.rs:35`
- What: `csg/topology_diagnostic.rs:20` notes the crate runs cargo-semver-checks. Every internal predicate tier is therefore public API: changing a `fixed::` signature counts as a breaking change, and dead items cannot be deleted freely.
- Fix: Make the kernel's internals `pub(crate)`. Re-export only `mesh_bridge::{subtract, union, intersection, …}`, `budget::*`, `mesh_volume`, the manifests needed by the determinism tests (or move those behind `test-support`), and `Sign` / `ImplicitPoint` if external tests need them. Delete the dead items. Hoist `pub type Tri` into `kernel/mod.rs`.
- Effort: M

### KERNEL-23: God functions, and modules split by line-count budget rather than by concept
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Long functions:
    - `rust/geometry/src/csg/consolidate.rs:143` (`consolidate_coplanar_with_unit_scale`, 209 lines)
    - `rust/geometry/src/facet_weld.rs:579` (`refine_high_aspect_slivers_impl`, 241) and `:150` (`weld_near_coplanar_facets`, 204)
    - `rust/geometry/src/simplify/cavities.rs:60` (`drop_enclosed_cavities`, 228)
    - `rust/geometry/src/kernel/retriangulate_recover.rs:30` (`recover_subsegment`, 148)
    - `csg/consolidate/conform.rs:233` (`conform_plans`, 112)
    - `cdt.rs:461` (107)
  - Large files: `cdt.rs` 1516, `kernel/retriangulate.rs` 935, `csg/consolidate.rs` 911, `facet_weld.rs` 923, `mesh.rs` 947
  - Modules whose doc says "split out of X to stay under the module-size ratchet": `csg/consolidate/{plane_merge,ring_ops,conform/{emit,raw,snap,open_edges}}.rs`, `csg/{degenerate_check,topology_diagnostic,union}.rs`, `kernel/{near_band,plane_weld,retriangulate_{audit,cleanup,recover}}.rs`, `kernel/arrangement/{coincident,ray_parity}.rs`, `cdt/{predicates,insertion,enc_grid}.rs`
- What: The size ratchet has produced `pub(super)` cross-file coupling (for example `classify.rs` exports `cross3`, `dot3` and `sub_f64` to `coincident.rs` and `boolean.rs`). `kernel/near_band.rs` hosts unrelated `vertex_bits` / `exact_vertex_set`. Several files are more than half comments, with long incident narratives inline.
- Fix: Group by concept (`kernel/classify/{regimes,probe,inside}.rs`, `kernel/math/{vec3,grid}.rs`) instead of by size. Move incident histories into `docs/architecture/kernel-decisions.md` and keep a one-line `// see KD-#1007` pointer in code. Break `consolidate_coplanar_with_unit_scale` into `bucket()`, `phase_a()`, `conform()` and `watertight_guard()`.
- Effort: L

### KERNEL-24: Retriangulation recomputes I1024 lambdas the interner already caches, uses a BTreeMap per-Vid cache, and clones constraints per triangle
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - From-scratch `fixed::point_to_f64` (I1024 recompute): `rust/geometry/src/kernel/retriangulate.rs:288` (`coord2d_cached`), `:451` (earcut, the whole ring on every call), `rust/geometry/src/kernel/retriangulate_cleanup.rs:43,62`
  - `BTreeMap<Vid, …>` cache for dense `u32` ids: `retriangulate.rs:225`
  - Per-triangle clones: `rust/geometry/src/kernel/arrangement/mod.rs:380,384` (`pts.get(i).cloned()`, `cons[i].clone()`)
  - `ImplicitPoint` is only `Clone`, although every variant is `Copy` (216-byte `Tpi`): `kernel/mod.rs:85-93`
  - `insert_point` rebuilds `mesh.tris` with a new allocation per inserted point: `retriangulate.rs:410-416`
  - `Interner::intern` does an O(n) `sorted.insert`: `kernel/interner.rs:78`
  - `tritri::plane_interval` allocates a `Vec` per tri pair: `kernel/tritri.rs:116`
- What: `fixed::point_to_f64_from_lam` exists precisely to avoid the recompute (`fixed.rs:499-514`), but only `classify::to_f64_pt` uses it. On wasm, wide-integer math is emulated, which is the cost the cached tiers were built to avoid.
- Fix: `coord2d_cached` and earcut should use `it.lam(v).and_then(point_to_f64_from_lam)` with `point_to_f64` as fallback, cached in `Vec<Option<[f64;2]>>` indexed by Vid. Make `RetriInput` borrow `&[Constraint]` / `&[ImplicitPoint]`. `#[derive(Copy)]` on `ImplicitPoint` / `Lpi` / `Tpi`. Use `retain` plus push in `insert_point`. Use `[usize; 3]` plus a count in `plane_interval`.
- Effort: S

### KERNEL-25: `DropAxis` / `Sign` helpers re-implemented at every use
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `DropAxis → (i, j)` ×6: `rust/geometry/src/kernel/predicates.rs:51`, `kernel/fixed.rs:97` (macro), `fixed.rs:384`, `kernel/interval.rs:199`, `kernel/rational.rs:81`, `rational.rs:209`
  - `normal_idx` / `project2d`: `kernel/retriangulate.rs:98,266`
  - Dominant axis ×2: `kernel/arrangement/classify.rs:103` (`drop_axis_of`) and `retriangulate.rs:110` (`axis_candidates`)
  - `Sign → Ordering` ×3: `kernel/interner.rs:65-69`, `kernel/arrangement/mod.rs:162-166`, `retriangulate.rs:156-162`
  - `sign_of` ×5: `fixed.rs:86,326`, `rational.rs:19`, `interval.rs:82`, `kernel/mod.rs:54`
  - `i32` sign convention in CDT / geom2d: `cdt.rs:119`, `geom2d.rs:85`
- Fix: `impl DropAxis { fn kept(self)->(usize,usize); fn idx(self)->usize; fn project(self,p)->[f64;2]; fn dominant(n)->Self }`, `impl From<Sign> for Ordering`, and `Sign::of<T: Signed>`.
- Effort: S

### KERNEL-26: FNV-1a hashing and test LCGs duplicated
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - FNV-1a: `rust/geometry/src/kernel/manifest.rs:37-46`, `kernel/arrangement/boolean.rs:265-278`, `kernel/retriangulate.rs:664-686` (plus `geom_hash.rs` crate-wide)
  - Test LCGs: `kernel/manifest.rs:20`, `kernel/predicates.rs:259`, `kernel/arrangement/classify_tests.rs:85`
- Fix: `fn fnv1a_u64(iter)` in `geom_hash.rs`, and one `test_support::Lcg`.
- Effort: S

### KERNEL-27: `predicates::orient2d` / `orient3d` are `pub` but call `unimplemented!` on legal argument orders; lambda helpers differ in totality
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/kernel/predicates.rs:37-40` and `:69-72`
  - `kernel/interval.rs:242`, `kernel/rational.rs:274`, `predicates.rs:114` (`unreachable!`)
- What: `orient2d(Explicit, Lpi, Explicit)` is a valid query that panics (abort in wasm). Only `orient2d_any` handles every position. Current callers are all-explicit or canonicalised, so this is unreachable today, but it is a public foot-gun.
- Fix: Make `orient2d` / `orient3d` delegate to the canonicalising dispatcher (`orient2d_any`), or make them `pub(crate)` and name them `orient2d_canonical`. Make all `lambda_of` helpers total, with `Explicit → (p, 1)`.
- Effort: S

### KERNEL-28: Latent out-of-range index panics in consolidation and AABB clipping (sibling code bounds-checks)
- Category: Bug
- Severity: Low
- Confidence: SUSPECT
- Where:
  - `rust/geometry/src/csg/consolidate.rs:90-101` (`count_spike_triangles(&mesh)` on the input mesh)
  - `consolidate.rs:81` → `csg/consolidate/conform/open_edges.rs:21` (on the input mesh at `:486`)
  - `consolidate.rs:527-537`
  - `rust/geometry/src/mesh.rs:857-860` (`clip_triangles_to_aabb`)
- What: The bucket loop in the same function skips out-of-range triangles (`consolidate.rs:182-185`), but the watertightness guard then indexes the raw input mesh without checks. Inputs today are kernel-produced and therefore valid, which is why this is SUSPECT rather than a live bug.
- Failure scenario: A future caller consolidates a non-kernel mesh with one bad index. Step 1 tolerates it, then `count_spike_triangles` panics, which aborts the wasm worker.
- Fix: Route these through the checked accessor from KERNEL-10.
- Effort: S

### KERNEL-29: Exact ray parity silently miscounts grazing hits; no detection or retry
- Category: Quirk
- Severity: Low
- Confidence: SUSPECT
- Where: `rust/geometry/src/kernel/arrangement/ray_parity.rs:21-32` (`exact_seg_hits_tri`), `:57` (`ray_dir`)
- What: An `orient3d == 0` hit on an edge or vertex returns `false` for every incident triangle, so a ray that passes exactly through a shared edge counts 0 crossings instead of 1, and parity flips. The fixed "generic" direction makes this rare but undetectable. `simplify/ray_parity.rs` detects grazes and discards the ray.
- Fix: Return a tri-state (`Hit` / `Miss` / `Graze`). On any `Graze`, re-cast along a second fixed direction (deterministic) and record a diagnostic counter.
- Effort: S

### KERNEL-30: `tritri::line_direction` passes a non-finite direction to the exact tier, which then panics
- Category: Bug
- Severity: Low
- Confidence: SUSPECT
- Where: `rust/geometry/src/kernel/tritri.rs:60-68`, `rust/geometry/src/kernel/rational.rs:15` (`expect("non-finite coordinate")`)
- What: If `n1 × n2` overflows (|coords| around 1e77 or more), `line_direction` returns `n` containing `inf`. The interval tier yields NaN and `None`, the fixed tier fails `gi`, and `rational::r(inf)` panics. This is unreachable via `Mesh` (f32 max 3.4e38 gives cross products around 1e155), but reachable through the public `kernel::arrangement::boolean(&[Tri])` with large finite f64 coordinates.
- Fix: Return `TriTri::None` (or treat as coplanar) when `!m.is_finite()`, and validate finiteness and magnitude at the public `Tri` entry points.
- Effort: S

### KERNEL-31: `retriangulate_cleanup`'s "1 mm" tolerance is in caller units, and the 2^-22 literal is duplicated
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/kernel/retriangulate_cleanup.rs:59` (`1.0e-3_f64.max(extent * (1.0 / 4_194_304.0))`) with its doc at `:29`
  - Same 2^-22 constant at `kernel/near_band.rs:54` and `csg/plane_eps.rs:96`
- What: The doc says "1 mm at building scale". The kernel runs in caller units (#2684), so in a mm file the floor is 1 µm. The difference from a metre file is up to about 400× at 10 m extents.
- Fix: Name the constant (`OUT_OF_PLANE_FLOOR`, documented in caller units like `NEAR_BAND_FLOOR`) and reuse `near_band`'s `F32_ULP_SCALE`. Decide explicitly whether it should scale with unit. `plane_eps` documents a deliberate local copy, which is fine; just reference the shared constant.
- Effort: S

### KERNEL-32: Duplicated clipper body and three plane-epsilon formulations (documented, still DRY)
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/csg/plane_eps.rs:229` (`clip_triangle_with_epsilon`)
  - `rust/geometry/src/router/voids/aabb_clip.rs:395` (hand-rolled `clip_triangle_against_box`, max-over-axes `1e-6`)
  - `rust/geometry/src/processors/boolean/halfspace_cap.rs:87`
  - `csg/mod.rs:276-290` (`bounds_overlap`, `span * 1e-6`)
- What: `plane_eps.rs:15-31` acknowledges the divergence and defers it. Listed here so the lead can track it in the cross-crate tolerance map.
- Fix: Have `aabb_clip` call `clip_triangle_with_epsilon` with a `PlaneEps` resolved per box plane.
- Effort: M

### KERNEL-33: `plane_weld` promotion is O(cutter_vertices × host_faces) on every subtract and union, outside the budget
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED (documented, deferred)
- Where: `rust/geometry/src/kernel/plane_weld.rs:248-326`, `:164-191` (up to 4 passes for union)
- What: Its own doc measures 39.7 ms → 571 ms on 4800-triangle disjoint boxes and states it sits outside #1109. It is listed because subtract (every void cut) pays the same quadratic, and the doc only discusses union.
- Fix: Index host faces by quantised plane (normal plus offset key, like `consolidate`'s bucket) and probe only candidate planes. Do it as its own manifest-re-pinning PR, as the doc says.
- Effort: M

### KERNEL-34: The determinism invariant "no FMA / `mul_add`" is enforced only by comments
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/geometry/src/kernel/interval.rs:16`, `kernel/manifest.rs:10`, `cdt.rs:36` (comments); `rust/geometry/Cargo.toml` `[lints.clippy]` has no rule for it. Pedantic clippy suggests `mul_add` at about 200 sites in scope (`~/rust-review/clippy-pedantic.txt`). There is also a redundant `#[allow(clippy::too_many_arguments)]` at `cdt.rs:671` (already allowed crate-wide).
- What: Applying one clippy suggestion would make an interval tier unsound (directed rounding assumes separately rounded ops) and break native == wasm. `rust/AGENTS.md` lists other numeric lints not to apply, but not this one.
- Fix: Add a `rust/geometry/clippy.toml` with `disallowed-methods = ["f64::mul_add", "f32::mul_add"]` and `disallowed_methods = "deny"` (or scope it to `kernel/`, `cdt`, `csg`), and mention it in `rust/AGENTS.md`.
- Effort: S

### KERNEL-35: The generic CDT core depends on the terrain module's error type
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/cdt.rs:240,252,613,808,879,920,960` (`crate::terrain_cdt::TerrainCdtError` in core signatures)
  - `rust/geometry/src/cdt/insertion.rs:9`
- What: Every CDT build and insert path takes `&mut dyn FnMut() -> Result<(), TerrainCdtError>`, and `fail_on_legalization_guard` is a terrain-specific mode flag on the core struct.
- Fix: A CDT-local `enum CdtAbort { Cancelled, WorkLimit }`, with `terrain_cdt` mapping it into its own error.
- Effort: S

### KERNEL-36: Stale comments referencing deleted code and renamed files
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/csg/mod.rs:279` ("before `manifold_kernel::difference` inflates it": the kernel is deleted and nothing inflates now)
  - `csg/degenerate_check.rs:19,48` (describe Manifold behaviour in the present tense)
  - `cdt.rs:10`, `kernel/retriangulate.rs:630`, `kernel/arrangement/mod.rs:188` (refer to `csg.rs`, now `csg/mod.rs`)
  - `kernel/interval.rs:255` (`ilambda_cached` computes and does not cache; misnomer)
  - `csg/mod.rs:233-242` (`has_operand_too_large_since`, a self-described historical relic still on the decision path)
- Fix: Update or delete; rename `ilambda_cached` to `ilambda_any`.
- Effort: S

## Tolerance inventory (kernel / csg / cdt / weld / simplify / mesh)

All values are in **caller units** unless marked; per #2684 the kernel runs in caller units (metres on the void path, file units on the boolean path).

| Constant | Value | Where | Unit / kind | Consistency notes |
|---|---|---|---|---|
| `SNAP_GRID` | 2^-16 | kernel/mesh_bridge.rs:31 | caller, absolute | Canonical grid; every row below that derives from it is re-declared (KERNEL-3) |
| `COARSE` / `FINE` / `FINE_OVER_COARSE` | 2^16 / 2^36 / 2^20 | kernel/fixed.rs:244-249 | grid scale | Must equal 1/SNAP_GRID and 2^20 α; not derived |
| `Q` / `S16` / `S36` | 2^20 / 2^16 / 2^36 | kernel/plane_weld.rs:361-363 | grid scale | Same as `fixed.rs`; independent literals |
| exact-i64 guard | 9.0e18 | fixed.rs:48, plane_weld.rs:384 | integer range | Duplicated |
| `line_direction` scale | 2^20 | kernel/tritri.rs:66 | direction quant | Tied to fixed-tier bit budget |
| aux-plane scale | 2^10 | kernel/coplanar.rs:83 | direction quant | Tied to the fine-grid 50-bit budget |
| `F32_ULP_SCALE` | 2^-22 | kernel/near_band.rs:54, csg/plane_eps.rs:96, retriangulate_cleanup.rs:59 (inline) | relative | Same value ×3 (plane_eps copy documented as deliberate) |
| `NEAR_BAND_FLOOR` | 8·SNAP_GRID | kernel/near_band.rs:64 | caller abs | 122 µm (m) / 122 nm (mm) |
| BComponents pad | 4·near_band_from_extent(max_ext) | classify.rs:325 | caller | Superset of the projected band (documented) |
| probe step | operand_extent·2^-20 | classify.rs:283,438; boolean.rs:111 | magnitude-relative | Not size-relative (KERNEL-18) |
| coincident cutoff | 45° (2d² ≥ \|a\|²\|b\|²) | arrangement/coincident.rs:53 | angle | Scale-free (pow2 normalised); fine |
| BVH pad | max(diag·1e-9, 1e-12) | kernel/broadphase.rs:156 | caller | — |
| retriangulate prefilter margin | 1e-6 + \|x\|·1e-9 | retriangulate.rs:319,348,490; retriangulate_recover.rs:407 | caller abs + rel | ×4, three formulas (KERNEL-15) |
| `PREFILTER_MIN` | 32 | retriangulate.rs:262 | count | — |
| out-of-plane tol | max(1e-3, ext·2^-22) | retriangulate_cleanup.rs:59 | caller abs | Doc says "1 mm" (KERNEL-31) |
| budget caps | 500 000 / 100 000 | kernel/budget.rs:62,90 | count | Not counted on tritri `cmp_along` (KERNEL-4) |
| volume-oracle tol | 1 % (floor 1e-9) | kernel/mesh_bridge.rs:290 | relative | — |
| `ClippingProcessor::epsilon` | 1e-6 | csg/mod.rs:199 | caller abs | Known unit divergence, documented (plane_eps.rs:53) |
| `bounds_overlap` eps | span·1e-6 | csg/mod.rs:288 | relative | Another formulation (KERNEL-32) |
| `edge_t` denom | 1e-12 | csg/plane_eps.rs:250 | caller abs | — |
| `calculate_normals` | try_normalize(1e-6) | csg/normals.rs:82 | caller abs | Unit-dependent degeneracy |
| `POS_QUANT` | 1e6 (1 µm) | csg/consolidate.rs:166 | metre-intended, caller-applied | KERNEL-19 |
| `NORMAL_QUANT_F64` | 1e3 | grid.rs:17 | unitless | Shared with facet_weld, good |
| bucket degeneracy | len < 1e-10 | consolidate.rs:213 | caller abs | — |
| open-edge grids | 1e3 / 1e4 | consolidate.rs:82,406,522 | metre-intended | KERNEL-19 |
| spike | ratio > 50, min > 1e-6 | consolidate.rs:108 | mixed | — |
| needle | min < floor_pow2(max)·2^-13 | consolidate.rs:52 | relative | Documented 64 m × 5 mm cost |
| `RIM_NOISE_OF_SIZE` / `RIM_NOISE_CAP` | 2^-13 / 2^-12 | consolidate/ring_ops.rs:12,16 | rel / metre (cap applied in caller units in the weld) | Partially unit-scaled (#4744) |
| `NOISE_AREA` / `NOISE_PLANE_SHARE` | 1e-8 / 1e-4 | ring_ops.rs:240,243 | caller² / share | — |
| collinear sin | 1e-4 (denominator 1e-18) | ring_ops.rs:166 | angle | — |
| `CONFORM_TOL` / seam grid / plane test | 1e-4 / 1e4 / 1e-5 | consolidate/conform.rs:38,65,286 | metre-intended | KERNEL-19 |
| orientation classifiers | 0.99999; 0.01 / 0.9999 | consolidate.rs:469,477 | cos | — |
| tag tolerances | 8·f32::EPSILON, floor 1e-9, cap SNAP_GRID/128, `MERGE_SAFE_MAGNITUDE` 128 | consolidate/plane_merge.rs:75-76,170-173 | rel / caller | Tied to SNAP_GRID (good, derived) |
| CDT quality | cos 22°, aspect 7, iters 20 000, Steiner 3n (min 32) | cdt.rs:97,100,103,1338 | unitless | — |
| CDT degeneracy | e0 ≤ 1e-15, circumcentre d < 1e-20, encroach (1 − 1e-12) | cdt.rs:1244,1267; cdt/enc_grid.rs:42 | caller abs | Absolute in caller units |
| CDT guards | legalize 4 000 000, recover 100 000 flips | cdt.rs:617,982 | count | — |
| facet weld | jitter 50e-6, move 200e-6, dedup 1e-4, anchor 100 | facet_weld.rs:90,97,103,251 | **metres** (void path only) | Metre path only, so consistent; not reusable on file units |
| sliver refine | aspect 8, rounds 64, `EDGE_SLACK` 4e-4, scoped splits 2048, min edge 1e-9 | facet_weld.rs:486,490,600,752,506 | metres / unitless | `EDGE_SLACK` tied to dedup grid (documented) |
| `drop_degenerate_triangles` | aspect 1e5 | mesh.rs:577 | unitless | Overlaps `clean_degenerate` (KERNEL-12) |
| `clean_degenerate` | height < SNAP_GRID | mesh.rs:~817 | caller abs | — |
| host-AABB clip pad | clamp(1e-3·diag, 5e-3, 1e-2) | mesh.rs:~934 | metres | — |
| subdivide normal | len > 1e-6 | mesh.rs:~496 | unitless | — |
| simplify | cell 0.0025·diag, growth 1.6, 10 iterations, weld 1e-6 | simplify/cluster.rs, simplify/mod.rs:57 | rel / metres | — |
| simplify ray parity | BARY 1e-9, t 1e-9·scale, det 1e-16, jitter 1e-7·scale | simplify/ray_parity.rs | mixed | Different robustness model from the kernel's (KERNEL-7) |
| cavities | open-edge ratio 0.05, area ratio 0.25, pad 1e-9·diag, 3e7 ray·tri cap | simplify/cavities.rs | rel | — |

Mutual consistency: the exact kernel's grids are internally consistent today but only by matching literals (KERNEL-3). The kernel's near band, plane weld and coincident tests are consistently caller-unit and scale-aware. The post-kernel stages (consolidate, retriangulate_cleanup, CDT degeneracy, the csg clipper floor) mix absolute metre-intended constants with caller-unit data (KERNEL-19, KERNEL-31), so the same physical geometry is treated differently in metre and mm files. facet_weld is metre-only and only reachable from the metre void path, so it is consistent.

## Concept inventory
- **Vector math:**
  - `kernel/arrangement/classify.rs:17` `cross3`, `:20` `dot3`, `:85` `sub_f64`
  - `kernel/tritri.rs:42` `sub_f64`, `:46` `cross_f64`, `:50` `plane_normal`, `:155-169` `ti_sub` / `ti_cross` / `ti_dot` / `ti_normal`
  - `kernel/coplanar.rs:28` `plane_normal`
  - `kernel/mesh_bridge.rs:70` `face_plane`
  - `kernel/signed_volume.rs:25` `tetra_volume6`
  - `facet_weld.rs:123` `tri_normal`
  - `kernel/rational.rs:49-67` BigRational `sub3` / `det3` / `cross`
  - `kernel/interval.rs:98-119` interval `ivec` / `isub` / `idet3` / `icross`
  - `kernel/fixed.rs:69-84` fixed-width `sub3` / `cross` / `det3`
  - `csg/mod.rs:107-140` `Triangle::{normal, cross_product, area}` (nalgebra)
- **Transforms / placements:** `mesh.rs:271` `Mesh::rebuilt_like` (frame carry), `mesh.rs:363` `Mesh::merge` (origin rebase); no placement math in scope.
- **Tolerances / epsilons:** `kernel/mesh_bridge.rs:31` `SNAP_GRID`; `kernel/fixed.rs:244-249` `COARSE` / `FINE` / `FINE_OVER_COARSE`; `kernel/plane_weld.rs:361-363` `Q` / `S16` / `S36`; `kernel/near_band.rs:54` `F32_ULP_SCALE`, `:64` `NEAR_BAND_FLOOR`, `:73` `NearBand`, `:176` `near_band_from_extent`; `csg/plane_eps.rs:96` `F32_ULP_SCALE`, `:122` `PlaneEps`; `kernel/retriangulate.rs:262` `PREFILTER_MIN`; `csg/consolidate/conform.rs:38` `CONFORM_TOL`; `csg/consolidate/ring_ops.rs:12,16,240,243` rim / noise constants; `facet_weld.rs:90,97,103,486` weld constants; `cdt.rs:97-103` quality constants; `kernel/budget.rs:62,90` `DEFAULT_CAP` / `DEFAULT_ELEMENT_CAP`; `grid.rs:17,21` `NORMAL_QUANT_F64` / `F32`; full list in the tolerance inventory above.
- **Unit conversion:** `csg/mod.rs:184` `ClippingProcessor.length_unit_scale`, `csg/consolidate.rs:134` `with_unit_scale`, `csg/consolidate/ring_ops.rs:213` `ring_is_noise(.., length_unit_scale)`.
- **Bbox / AABB:**
  - `kernel/broadphase.rs:36` `Aabb`, `:38` `tri_aabb`, `:50` `overlap`, `:55` `aabb_contains`, `:62` `seg_hits_aabb`, `:112` `EMPTY_AABB`, `:116` `tris_aabb`, `:95` `Bvh` (`bounded.rs`, `nearest.rs`)
  - `kernel/arrangement/classify.rs:327` BComponents AABB, `:362` `ray_may_hit` slab
  - `kernel/signed_volume.rs:86` `aabb_centre`
  - `mesh.rs:~643` `Mesh::bounds`, `mesh.rs:~851/929` `clip_triangles_to_aabb` / `_host_aabb`
  - `kernel/retriangulate.rs:300/329` 2D prefilter boxes
  - `csg/mod.rs:271` `bounds_overlap`
- **Hashing:** `kernel/manifest.rs:37` FNV-1a `mix`, `kernel/arrangement/boolean.rs:265` `boolean_topology_hash`, `kernel/retriangulate.rs:664` `triangulation_topology_hash`, `kernel/near_band.rs:182` `vertex_bits`, `:196` `exact_vertex_set`.
- **Triangulation / polygon ops:**
  - `cdt.rs:1376` `triangulate_refined`, `:1406` `triangulate_constrained`, `:1440` `triangulate_pslg`, `:1475` `triangulate_pslg_with_progress`
  - `kernel/retriangulate.rs:439` `earcut` (exact, Vid), `:560` `triangulate`, `:135` `projection_axis`
  - `kernel/coplanar.rs:126` `coplanar_clip`
  - `kernel/tritri.rs:244` `tri_tri_intersection`
  - `csg/consolidate/ring_ops.rs:43` `weld_near_coincident_2d`, `:96` `simplify_2d_collinear`, `:187` `clean_ring`, `:245` `floor_pow2`
  - `csg/consolidate/conform.rs:109` `conform_ring`
  - `csg/plane_eps.rs:229` `clip_triangle_with_epsilon`
  - `cdt/predicates.rs:28` `segments_properly_cross`, `:22` `strictly_between`, `:39` `rings_to_pslg`
  - `kernel/arrangement/mod.rs:115` `segments_cross`, `kernel/coplanar.rs:46` `seg_seg_cross`, `:39` `point_in_tri`, `kernel/arrangement/classify.rs:120` `point_in_tri_proj`
- **Exact predicates:** `kernel/predicates.rs:21` `orient3d`, `:49` `orient2d`, `:80` `orient2d_2i`, `:91` `orient2d_3i`, `:101` `cmp_lex`, `:123` `orient2d_any`; `kernel/tritri.rs:85` `cmp_along`; `kernel/retriangulate.rs:39` `orient2d_v`, `:63` `cmp_lex_v`; `kernel/mod.rs:46` `Sign`, `:78` `DropAxis`, `:129` `assemble_sign`; `kernel/fixed.rs:344` `cached_lambda`, `:478` `point_to_f64`, `:505` `point_to_f64_from_lam`; `kernel/interval.rs:21` `RnInterval`, `:28/41` `next_up` / `next_down`.
- **Mesh welding / merging:** `mesh.rs:723` `Mesh::welded_by_position`, `mesh_position_weld.rs:18` `weld_impl`, `facet_weld.rs:150` `weld_near_coplanar_facets`, `:549` `refine_high_aspect_slivers`, `kernel/plane_weld.rs:164` `promote_operands_mutually`, `:248` `promote_cutter_verts_onto_host_faces`, `:360` `exact_on_plane_weld`, `simplify/cluster.rs` `cluster_decimate`, `mesh.rs:363` `merge`, `mesh.rs:416` `merge_all` (dead).
- **Volume:** `kernel/signed_volume.rs:56-121` (`signed_volume6`, `_about`, `volume_reference`, `signed_volume_of`), `kernel/mesh_volume.rs:74` `mesh_volume` (snapped).
- **Point-in-solid:** `kernel/arrangement/ray_parity.rs:135` `point_inside`, `:102` `sound_far`, `:37` `operand_extent`, `:57` `ray_dir`; `kernel/arrangement/classify.rs:35` `point_inside_bvh`; `simplify/ray_parity.rs` `point_enclosed`.
- **Topology audit:** `csg/consolidate/conform/open_edges.rs:15` `count_open_boundary_edges_at`, `csg/consolidate.rs:527` `count_open_boundary_edges_exact`, `csg/topology_diagnostic.rs:62` `record_topology_tear`, `test_support.rs:20` `open_edges`.
- **Degeneracy:** `csg/consolidate.rs:43` `tri_is_needle`, `:90` `count_spike_triangles`, `mesh.rs:573` `drop_degenerate_triangles`, `mesh.rs:~743` `drop_thin_triangles`, `mesh.rs:~817` `clean_degenerate`, `cdt.rs:1221` `tri_is_skinny`, `facet_weld.rs:494` `aspect`, `csg/mod.rs:145` `Triangle::is_degenerate`.
- **Mesh representations:** `mesh.rs:52` `Mesh` (f32 soup plus frame metadata), `mesh.rs:107` `SubMesh`, `kernel/arrangement/mod.rs:43` `Tri = [[f64;3];3]` (also `coplanar.rs:21`, `broadphase.rs:35`), `csg/mod.rs:69` `Triangle` (nalgebra), `kernel/retriangulate.rs:203` `Mesh2d` (Vid triangles), `cdt.rs:140` `Tri` (CDT adjacency), `csg/consolidate/plane_merge.rs:37` `PlaneTri`, `mesh.rs:45` `PlaneTag`. Outside scope: `rust/core/src/fast_parse.rs:259` `FastMeshData`, `rust/wasm-bindings/src/zero_copy/mesh.rs:33` `MeshDataJs`.
- **Colour / style resolution:** none in scope.
- **Error types:**
  - Kernel uses `Option` / `bool` returns and `Sign::Zero` for degeneracy.
  - `csg/group_cut.rs:21` `GroupCut`, `:68` `GroupReject`; `kernel/mesh_bridge.rs:177` `BatchSubtract`.
  - `csg/mod.rs` uses `crate::error::Result` and `crate::diagnostics::{BoolFailure, BoolFailureReason}`.
  - `cdt.rs` uses `crate::terrain_cdt::TerrainCdtError`.
  - `kernel/fixed_int/mod.rs:263` `ParseFixedIntError`.
  - `kernel/broadphase/bounded.rs` and `nearest.rs` return `Result<_, &'static str>` (stringly typed).
