I found no `unsafe` code anywhere in Scope A. Scope B has one likely crash: the clash BVH sorts with a comparator that is not a total order when coordinates are NaN. The rest of what I found is duplication between crates, some of which has drifted, plus a few stale comments. This was read-only: I ran no cargo, no Plato generator and no tests, so the BVH panic is reasoned from the code and the Rust 1.81+ sort contract, not reproduced.

**Scope A soundness:** `rust/wasm-bindings/src` has no `unsafe`, `Float32Array::view`, `from_raw_parts`, `mem::forget`, `Box::into_raw` or pointer getters. Every typed-array getter copies (`js_sys::*Array::from`). So the memory-growth invalidation and dangling ptr/len questions do not apply today.

**Plato:** `generated/plato.rs` comes from `tools/plato/clash_math.plato` via `scripts/generate-plato-clash.mjs`. The generator is present and CI checks the output is fresh (`.github/workflows/test.yml:2764`, `plato-check`). The source and the output were last changed in the same commit (223f4d71f2), so it does not look stale.

### EDGE-1: Clash BVH sorts with a comparator that breaks on NaN, which can panic and abort the shared wasm module
- Category: Bug
- Severity: High
- Confidence: LIKELY
- Where: rust/clash/src/bvh.rs:224-228; NaN reaches it from rust/clash/src/tri_mesh.rs:362-386 (`tri_bounds` NaNs a triangle's bounds on purpose, #5220) and from element AABBs at rust/clash/src/session.rs:271-276. The sibling BVH in rust/geometry/src/kernel/broadphase.rs:273-275 already fixed this.
- What: `ca.partial_cmp(&cb).unwrap_or(Ordering::Equal)` makes NaN "equal" to everything, which is not transitive. Since Rust 1.81, `sort_by` "may panic if the comparison does not implement a total order"; small slices (≤20) use insertion sort, larger ones can detect the violation and panic. broadphase.rs:273 says it switched to `total_cmp` to avoid this "Equal-on-NaN escape hatch". The only NaN test is a one-triangle mesh (kernel_tests.rs:869-912), so the larger-sort path is never exercised.
- Why it matters: tri_mesh.rs:57-61 says a panic under `panic = abort` traps the instance and poisons geometry, parsing and clash together. The code expects NaN vertices (#5220), so this is a reachable crash in a path documented as panic-free.
- Fix: in `build_node`, use a total comparator that keeps TS order for finite values, e.g. `match (ca.is_nan(), cb.is_nan()) { (false,false) => ca.partial_cmp(&cb).unwrap(), (x,y) => x.cmp(&y) }`. Add a test with a NaN-vertex mesh of more than 20 triangles. NaN leaves never intersect a query, so verdicts don't change; only tree shape for NaN meshes differs from TS.
- Effort: S

### EDGE-2: Z-up/Y-up basis matrix and row-major 4x4 multiply copied across three crates
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Matrix: rust/wasm-bindings/src/zero_copy/frame_swap.rs:35-62 (S, Sᵀ, local `matmul`); rust/processing/src/simplify_math.rs:28-57 (S, Sᵀ, `matmul_row_major`, the jscpd pair); rust/export/src/gltf/matrix.rs:33-66 (`S_YUP`, `S_YUP_INV`, `mat4_mul`); rust/export/src/frame.rs:40-70 (`yup_matrix4`, column-major, same math done by permutation).
  - Point swap `(x,y,z)->(x,z,-y)`: rust/wasm-bindings/src/zero_copy/mesh.rs:307-326 (inline); rust/processing/src/simplify_math.rs:13-22; rust/export/src/frame.rs:20-28.
  - Test/example multiply copies: rust/export/src/gltf_tests.rs:318; rust/export/examples/world_check.rs:34.
- What: there is no behavioural drift; all copies compute S·M·Sᵀ or its inverse consistently. But frame_swap.rs:5 claims the conversion lives "in one place", and simplify_math.rs:24-25 points to `zero_copy::mesh::swap_zup_to_yup_mat4`, which has moved to `frame_swap`.
- Why it matters: frame_swap's own doc says this correction is "easy to get subtly wrong and impossible to notice". There are four places it can now go wrong.
- Fix: put one `frame` module in `ifc_lite_geometry`, which wasm-bindings, processing and export all already depend on. It would hold the S constant, `zup_to_yup<T>` / `yup_to_zup<T>`, `swap_zup_to_yup_aabb<T>`, `conjugate_zup_to_yup` / `conjugate_yup_to_zup`, and `mat4_mul_row_major`. Point every site above at it.
- Effort: M

### EDGE-3: Symbolic primitives exist twice and are copied field by field
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/wasm-bindings/src/zero_copy/symbolic.rs:9-511 vs rust/processing/src/symbolic/primitives.rs:69-200.
  - Positional copying in rust/wasm-bindings/src/zero_copy/symbolic_from_data.rs:40-116. Its own doc at :7-13 says nothing in the compiler can catch a transposed pair.
  - Hand-written clones in symbolic.rs:585-658 (`get_polyline`, `get_circle`, `get_text`, `get_fill`).
  - Constructor and default duplicates: symbolic.rs:198-218 `full_circle` vs primitives.rs:108 `full`; the near-black text default at symbolic.rs:323 vs rust/processing/src/symbolic/text.rs:109.
  - Stale comment: primitives.rs:63-64 calls the wasm types "thin views" in `zero_copy.rs`, a file that no longer exists.
- What: `SymbolicCircle::new` takes six adjacent `f32` arguments (`center_x, center_y, radius, world_y, start_angle, end_angle`), so a swap compiles silently. mesh.rs:11-15 moved `MeshDataJs` to `#[derive(Clone)]` for exactly this reason, but the symbolic types still enumerate every field by hand. `SymbolicText::new` and `full_circle` are only called from tests.
- Why it matters: the server/browser "bit-identical" contract depends on four transcriptions with no compiler check. symbolic.rs is also on the module-size allowlist (757-line budget).
- Fix: make the wasm types newtypes over the processing types, e.g. `#[wasm_bindgen] pub struct SymbolicPolyline(ifc_lite_processing::SymbolicPolyline)`. The fill wrapper also carries `geometry_item_id`. Derive `Clone`, read getters from `.0`, and reduce `from_data` to `map(Wrapper)`.
- Effort: M

### EDGE-4: Box-face normal code duplicated between clash and geometry, and the two have drifted
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED (the drift); LIKELY (the impact)
- Where:
  - `canonical` copied verbatim: rust/clash/src/obb_detect.rs:27-40 vs rust/geometry/src/clash_contact_axes.rs:37-50 (the jscpd pair). A third copy is the TS `canonical` in `packages/clash/src/engine-ts/obb-detect.ts`.
  - Degenerate-normal test: obb_detect.rs:16-22 (`len > OBB_EPS`, a fixed 1e-6 on the raw cross product) vs clash_contact_axes.rs:118-141 (scale-free `MIN_SIN_THETA`).
  - Family-merge tolerance: obb_detect.rs:155-156 (`max(1e-6, e²/2)` from the noise estimate) vs clash_contact_axes.rs:32,204 (fixed `ORTHO_EPS` 1e-4).
- What: clash_contact_axes.rs:111-112 calls a fixed length threshold on the cross product "the original bug" because it is not scale-free. clash still uses one. Any face with |e1×e2| ≤ 1e-6 m² (for example 1 mm × 1 mm) is dropped, the mesh loses a face family, `detect_obb` returns `None`, and the exact box depth falls back to the AABB estimate.
- Why it matters: small boxy members get an `Estimate` instead of a certified `Mesh` depth. The result stays on the safe side, but the two copies now disagree about what counts as a face.
- Fix: put `canonical` and a scale-free degenerate test in `tools/plato/clash_math.plato`, so Rust clash and TS are both generated from it. Then let geometry import them from `ifc-lite-clash`: it has zero dependencies and is already a dev-dependency (rust/geometry/Cargo.toml:141-144). The merge tolerances serve different purposes, so document that difference rather than unify it.
- Effort: M

### EDGE-5: Clash session keeps up to three copies of each element's geometry
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/clash/src/session.rs:111-114 (all positions widened from f32 to f64 at ingest); :140-143 (`TriMesh::new(element.positions.clone(), element.indices.clone())`); :39-45 (`Element` keeps its raw copy for the whole session).
- What: every element pays twice its f32 size up front, even if it is never a candidate. Every candidate then holds the f64 positions twice, plus indices twice.
- Why it matters: the wasm32 heap is limited, and clash ingests whole federated models.
- Fix: store the f32 data (or ranges into one shared buffer) in `Element`, widen inside `TriMesh::new` (f32→f64 is exact, so results are bit-identical), and hold the mesh in something like `RefCell<enum { Raw(..), Built(TriMesh) }>` so building moves the raw data instead of cloning it.
- Effort: S

### EDGE-6: The `zero_copy` module name and its docs claim views that don't exist
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - rust/wasm-bindings/src/zero_copy/mod.rs:5-7 and :25-29 (`get_memory`, "allow JavaScript to create TypedArray views").
  - rust/wasm-bindings/src/api/mod.rs:543-547 ("for zero-copy access").
  - rust/wasm-bindings/src/zero_copy/symbolic.rs:371-373 ("view the buffer").
  - Free `get_memory` re-exported at rust/wasm-bindings/src/lib.rs:84 with no TS consumer. The only `getMemory` caller is heap-size accounting at packages/geometry/src/geometry.worker.ts:1318.
  - No `forbid(unsafe_code)` in any crate.
- What: every getter copies.
- Why it matters: someone trusting these docs may add `Float32Array::view` (which is an `unsafe fn` in js-sys) and bring in the memory-growth invalidation hazard without a SAFETY review.
- Fix: correct the docs (or rename the module), drop the free `get_memory` export (this changes the committed `.d.ts`), and add `#![forbid(unsafe_code)]` to wasm-bindings and clash, neither of which has any `unsafe` today.
- Effort: S

### EDGE-7: `MeshCollection` lists all 11 fields in four separate places
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/wasm-bindings/src/zero_copy/mesh.rs:630-644 (`new`), :647-661 (`with_capacity`), :682-696 (`from_vec`), :721-737 (manual `Clone`).
- What: every field other than `meshes` is zero, empty or `None`. The warning at mesh.rs:17-30 against spreading `Default` is about `MeshDataJs`, where `new` and `Default` really differ; it does not apply here.
- Why it matters: four places to edit for each new field, in a file on the allowlist (754-line budget).
- Fix: `#[derive(Clone, Default)]`, then write the constructors as `Self { meshes, ..Self::default() }`.
- Effort: S

### EDGE-8: The f32-ULP constant 2^-22 is defined in five places, with stale cross-references
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/clash/src/depth.rs:212; rust/clash/src/generated/plato.rs:113,245 (from tools/plato/clash_math.plato:207,238-240); rust/geometry/src/kernel/near_band.rs:54; rust/geometry/src/csg/plane_eps.rs:96; rust/geometry/src/kernel/retriangulate_cleanup.rs:60 (inline literal).
- What: depth.rs:206-207 says the reference lives in `kernel/mesh_bridge.rs`; it is actually at near_band.rs:176. near_band.rs:52-53 and plane_eps.rs:92-93 cite `packages/clash/src/contact/narrow-phase.ts`, which does not exist.
- Why it matters: within clash, if the Plato literal changes, the normal-error bound in obb_detect (which uses `F32_ULP_SCALE`) silently diverges from the tri-tri noise band.
- Fix: declare it once in clash_math.plato and have depth.rs use the generated value. In geometry, keep one `pub(crate) const` in near_band.rs and use it from plane_eps and retriangulate_cleanup. Fix the three stale references.
- Effort: S

### EDGE-9: Margin formula computed twice, and differs from TS (comments call it a bit-for-bit port)
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/clash/src/session.rs:198 and rust/clash/src/narrow.rs:71, vs packages/clash/src/engine-ts/narrow.ts:57 and packages/clash/src/engine-ts/ts-kernel.ts:55.
- What: Rust only adds the clearance when `mode == 1` and `f64::max` drops a NaN. TS uses `Math.max(tolerance, rule.clearance ?? 0)` in every mode and propagates NaN. Verdicts match: the extra TS candidates can only come out as `None` in hard mode. NaN tolerance is caught only in TS (orchestrator.ts:59); the Rust public API accepts it and silently reports no touches.
- Why it matters: narrow.rs:5-7 claims a bit-for-bit port, and the same value is computed in two places.
- Fix: compute the margin once in the session and pass it into `test_pair`. Reject or `debug_assert` non-finite tolerance/clearance in `run_rule_with_depth_floors`. Document the mode gating.
- Effort: S

### EDGE-10: Two separate AABB BVHs; the clash one allocates per node and tests leaves twice
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/clash/src/bvh.rs:80-238 vs rust/geometry/src/kernel/broadphase.rs:88-282. Per-node `Box` at bvh.rs:198,232; repeated leaf test at :158/:163 and :138/:143.
- What: keeping them separate is justified (clash must match TS and has no dependencies). But the clash BVH makes 2n-1 heap nodes per triangle mesh, and its single-item leaves have the same bounds as their item, so the "re-check" repeats the same box test.
- Why it matters: allocation and pointer chasing on every element mesh built in the narrow phase.
- Fix: a flat `Vec<Node>` like broadphase.rs, with the same tree shape so TS parity is kept, and drop the redundant leaf test.
- Effort: S

### EDGE-11: Clash test fixtures copy the same box and packing code many times
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - Box index table: rust/clash/src/tests.rs:37-44, 97-100, 145-148, 198-201, 255-258; rust/clash/src/kernel_tests.rs:41-44; rust/clash/src/world_frame_tests.rs:136-139; rust/clash/src/obb_detect_tests.rs:23-26.
  - Session packing: tests.rs:51-77, 106-125, 368-386; kernel_tests.rs:56-74; world_frame_tests.rs:103-146; rust/geometry/tests/clash_intersection_real_model.rs:268-283.
- What: `unit_cube` and `sized_cube` are special cases of `box_hxyz` / `box_mesh`, and the jscpd hit tests.rs:22-35 vs 83-96 is one such pair.
- Why it matters: a fix to one fixture doesn't reach the others.
- Fix: one `#[cfg(test)] mod fixtures` in clash with `box_mesh(c, h)` and `pack_session(parts)`; build the other shapes on top.
- Effort: S

### EDGE-12: `[f64;3]` vector helpers are re-written throughout the workspace
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where (verified sites):
  - Cross: rust/geometry/src/kernel/tritri.rs:46 (`cross_f64`) and :159 (`ti_cross`), both in the same file; rust/geometry/src/clash_contact_axes.rs:56; rust/geometry/src/kernel/arrangement/classify.rs:17; rust/geometry/src/router/voids/prism_cut.rs:238; rust/processing/src/appearance/authored.rs:21.
  - Dot: clash_contact_axes.rs:52, classify.rs:20, tritri.rs:163, prism_cut.rs:222, rust/export/src/geom.rs:231, rust/processing/src/appearance/{authored.rs:18, mapping.rs:31, calibration.rs:36}.
  - Clash's own helpers: rust/clash/src/vec3.rs:31-68, wrappers over Plato (justified: no dependencies, TS parity).
- What: "too short to normalize" has drifted: rust/clash/src/obb_detect.rs:18 uses a fixed 1e-6, prism_cut.rs:252 a fixed 1e-12, clash_contact_axes.rs:83 zero or non-finite. geometry, processing and export already depend on nalgebra.
- Why it matters: threshold drift like this is the bug class in EDGE-4.
- Fix: one `pub(crate) mod vec3` in geometry (or nalgebra `Vector3`) for geometry, processing and export, with the threshold as an explicit argument. Clash keeps its Plato-backed helpers.
- Effort: M

### EDGE-13: Two doc comments are attached to the wrong function
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/clash/src/obb_detect.rs:48-67; rust/geometry/src/clash_solid_geom.rs:121-135.
- What: `detect_obb`'s doc ("Detect whether `mesh` is a rectangular box…") sits on top of `normal_angle_error`, and `detect_obb` (obb_detect.rs:101) has none of its own. In clash_solid_geom.rs, `operand_near_band`'s doc ("Per-axis coordinate extents…") runs into `trust_gate_reason`'s, and `operand_near_band` (:193) is undocumented.
- Why it matters: rustdoc and IDE hovers show the wrong explanation.
- Fix: move each paragraph onto its own function.
- Effort: S

## Concept inventory (Scope A, Scope B, and related geometry clash files)

**Vector and matrix math**
- rust/clash/src/vec3.rs:31-68 (`sub`, `add`, `scale`, `cross`, `dot`, `dist_sq`, `mid`, `centroid`)
- rust/clash/src/generated/plato.rs:157-204 (`Vec3`, `TriTriSat`, `PairNoise`, `Band`)
- rust/clash/src/obb_detect.rs:16 (`normalize`), :27 (`canonical`), :68 (`normal_angle_error`), :281 (`family_axes`)
- rust/clash/src/obb.rs:74 (`obb_penetration`), :178 (`proj_radius`)
- rust/geometry/src/clash_contact_axes.rs:37 (`canonical`), :52 (`dot3`), :56 (`cross3`), :81 (`normalize3`), :123 (`face_normal`)
- rust/wasm-bindings/src/zero_copy/frame_swap.rs:49 (`matmul`); rust/processing/src/simplify_math.rs:45 (`matmul_row_major`); rust/export/src/gltf/matrix.rs:54 (`mat4_mul`)

**Transforms**
- rust/wasm-bindings/src/zero_copy/frame_swap.rs:25 (`swap_zup_to_yup_aabb`), :34 (`swap_zup_to_yup_mat4`)
- rust/wasm-bindings/src/zero_copy/mesh.rs:307-335 (inline position, normal and origin swap)
- rust/processing/src/simplify_math.rs:13, :20, :26
- rust/export/src/frame.rs:20, :26, :40
- rust/export/src/gltf/matrix.rs:33-45

**Tolerances and epsilons**
- rust/clash/src/triangle.rs:17 (`EPS` 1e-12); rust/clash/src/generated/plato.rs:201 (1E-12, tri-tri parallel test)
- rust/clash/src/tri_mesh.rs:22 (`RAY_DIR`), :24 (`RAY_EPS` 1e-9)
- rust/clash/src/obb.rs:35 (`OBB_EPS` 1e-6), :50 (`AXIS_NOISE_ULPS` 8)
- rust/clash/src/obb_detect.rs:99 (`MAX_NOISE_ANGLE` 0.1)
- rust/clash/src/depth.rs:212 (`F32_ULP_SCALE`); rust/clash/src/generated/plato.rs:113, :245 (2^-22)
- rust/geometry/src/clash_contact_axes.rs:32 (`ORTHO_EPS` 1e-4), :118 (`MIN_SIN_THETA` 1e-3), :168 (`MAX_FACE_FAMILIES`)
- rust/geometry/src/kernel/near_band.rs:54; rust/geometry/src/csg/plane_eps.rs:96
- rust/wasm-bindings/src/zero_copy/symbolic.rs:161 (full-circle tolerance 0.001)

**Bounding boxes / AABB**
- rust/clash/src/aabb.rs:19 (`Aabb`), :54 (`from_positions`, used only in tests), :100 (`signed_gap`), :106 (`overlap_bounds`), :111 (`bounds_of_points`), :122 (`aabb_contains`), :130 (`depth_floor`), :137 (`estimate_floor`)
- rust/clash/src/generated/plato.rs:206 (`Box3`)
- rust/clash/src/bvh.rs:23/:35 (`js_max` / `js_min`), :48 (`ray_intersects_aabb`), :89 (`Bvh`), :178 (`compute_bounds`)
- rust/clash/src/tri_mesh.rs:50 (`cube_around`), :369 (`tri_bounds`)
- rust/geometry/src/kernel/broadphase.rs:36-131 (`Aabb` tuple, `tri_aabb`, `overlap`, `seg_hits_aabb`, `EMPTY_AABB`, `tris_aabb`), :95 (`Bvh`)
- rust/geometry/src/router/voids/coaxial_union.rs:529 (`aabb_overlap`)
- rust/wasm-bindings/src/zero_copy/mesh_fingerprint.rs:37, :87 (world AABB array)

**Hashing**
- rust/clash/src/session.rs:281 (`HashSet<(u32,u32)>`, used only to dedup; output order comes from a `Vec`, so it is deterministic)
- rust/geometry/src/clash_solid_geom.rs:93 (`HashMap<[u64;3],usize>`; groups are output in index order)
- rust/wasm-bindings/src/zero_copy/mesh_fingerprint.rs:153 (`push_geometry_hash`; the hashes come from `ifc_lite_geometry::geom_hash`)

**Triangulation and polygon operations**
- rust/clash/src/triangle.rs:32 (`tri_tri_intersect`), :64 (`closest_pt_seg_seg`), :120 (`closest_pt_point_triangle`), :172 (`tri_tri_distance`)
- rust/clash/src/tri_mesh.rs:56-83 (index sanitization), :260 (`closest_on_surface`), :311 (`contains_point`, Möller–Trumbore)
- rust/geometry/src/kernel/tritri.rs:244 (exact CSG kernel; separate on purpose)
- rust/wasm-bindings/src/zero_copy/symbolic.rs:378-392 (`holes_offsets` ring layout)

**Error types**
- None in clash: bad input is silently cleaned up (session.rs:90-122, tri_mesh.rs:57-83).
- rust/clash/src/generated/plato.rs:251 (`Error` unit struct, never used).
- zero_copy has none: a diagnostics serialization failure becomes `undefined` at rust/wasm-bindings/src/zero_copy/mesh.rs:622.
- The only typed error on the clash path is on the TS side: `NonFiniteToleranceError` at packages/clash/src/engine-ts/orchestrator.ts:43.