## F2a design note (coordinator b61983f5)

Work package F2a (#7772, charter #7670): the cross-crate math home. This note is based on `origin/main` at `4f3197201f`. Every file:line below was re-measured there; where a finding's line is stale, the current line is given and the finding text is marked *stale*.

Findings closed: XCUT-3, XCUT-4, XCUT-5, XCUT-8, XCUT-19 (the clash/geometry bullet only, §4), EDGE-CLASH-2, EDGE-CLASH-4, EDGE-CLASH-8 (the clash half), EDGE-CLASH-12, EDGE-WASM-9, EXPORT-GEOM-3, GEOM-11, GEOM-15, KERNEL-5, PROCESSING-10, PROCESSING-11, PROCESSING-12 (3D half), PROCESSING-APP-3, PROCESSING-APP-4 (3D half), PROCESSING-APP-15, PROCESSING-SYM-11, ROUTER-11, ROUTER-14, ROUTER-42 (the copy; the tolerance values go to F2c), SERVER-15.

### TL;DR of the decisions

1. **The home is plain arrays plus free functions, not a type library.** Measured on main, no crate uses `glam`. `nalgebra` (`Point3`/`Vector3`/`Matrix4`) is geometry's interior type: 258 `Point3<` and 81 `Matrix4<` uses in geometry, and almost none outside it. Every *cross-crate* signature on main is already an array: `InstanceMeta.transform: [f64; 16]` row-major, `origin: [f64; 3]`, `local_bounds: [f32; 6]`. Non-test `[f64; 3]` uses: geometry 353, processing 157, export 105, server 17, wasm 12. So `math` works on `[f64; 3]` and row-major `[f64; 16]`. The only struct is `Aabb3`, because an AABB needs an invariant (the empty sentinel and well-formedness) that a tuple cannot carry. `nalgebra` stays geometry-internal; `math` offers exact bridges to it.
2. **Layout:** `rust/geometry/src/math/{mod.rs, v3.rs, mat4.rs, aabb.rs, frame.rs}`, each under 250 lines of production code, with tests in sibling `*_tests.rs` files (module-size ratchet: split, don't allowlist). `pub mod math` is added to `lib.rs`, and the module-visibility comment at `lib.rs:70-75` changes from "8 modules" to 9. Nothing is re-exported at the crate root, so `dot`/`cross` cannot collide with anything.
3. **Canonical bodies are the majority spelling, copied verbatim.** The op order is `a0*b0 + a1*b1 + a2*b2`, left-associative, FMA-free, with no `mul_add`. The 4×4 multiply is the 0.0-initialised `r, c, k` triple loop, which export, processing, wasm and server already share token for token. So most migrations are byte-identical by construction. Every minority spelling is in §3, with either a proof of bit-equality for finite input or an X PR.
4. **One `normalize(v, min_len) -> Option<[f64; 3]>`.** It returns `None` iff the length is not finite or is `<= min_len`, and otherwise divides each component by the length. The threshold is an argument; F2c names the values. Each caller's degenerate fallback (zero vector, `+Z`, the input itself) becomes an explicit `.unwrap_or(..)` at the call site.
5. **Frame conjugation is an exact signed permutation, with the sign of zero folded to `+0.0`.** For every finite input this is bit-identical to the `S·M·Sᵀ` matmul that wasm, processing and server use today, and it works on row-major and column-major arrays alike, because conjugating by a signed permutation commutes with transposition. Point swaps do **not** fold `-0.0`; every copy agrees on that.
6. **Clash/geometry seam: keep the 14-line clone and add a parity test. Do not promote the dev-dependency** (reasons in §4). The parity test compiles clash's `canonical` into geometry's tests through `#[path]`, the same way `world_frame_corpus.rs` is shared today (#5406).
7. **F2a adds public API only, so there is no semver break.** No `pub` item of a published crate is removed or changed, so nothing is appended to `rust-major-offset.json` (§1.4).
8. **The prism_cut vector kit and the `router/voids/*` AABB folds are not touched.** C2 owns those files in waves 3–4, and F1a forbids early edits to `prism_cut.rs`. C2 consumes `math` when it restructures them. This is recorded in the ledger as a C2 obligation, not a third copy.
9. **There are 14 PRs: 9 R and 5 X.** Core, ffi, landxml and python get **no** PR. Core sits below geometry and cannot depend on it. Ffi and python have zero copies. LandXML's only vector code is its own plan-coordinate math, which C1d/C9c own.

---

### 1. API

#### 1.1 Module layout (`rust/geometry/src/math/`)

| File | Public items (`pub` unless marked) | Notes |
|---|---|---|
| `mod.rs` (~40 lines) | `pub mod v3; pub mod mat4; pub mod aabb; pub mod frame;` | The module doc states the conventions once: f64 throughout; row-major `[f64; 16]`; no FMA or `mul_add`; the op order is part of the contract, because `mesh_determinism` and the fingerprints pin outputs that pass through it; NaN behaviour per function; f32 only at named boundary casts (the B5 rule). |
| `v3.rs` (~110) | `type V3 = [f64; 3]`; `add`, `sub`, `scale(a, s)`, `dot`, `cross`, `norm` (`dot(a,a).sqrt()`), `dist(a, b)` (`norm(sub(a, b))`), `normalize(v, min_len) -> Option<V3>`, `tri_normal(a, b, c) -> V3` (unnormalised `cross(sub(b,a), sub(c,a))`), `canonical(n) -> V3` (the antipodal sign rule: the largest-magnitude component becomes positive, ties broken x, y, z) | Every fn is `#[inline]`. There is no `lerp`: its only user is `prism_cut` (C2), which adds it when it migrates. There is no `v2`; 2D belongs to F2b (§9). |
| `mat4.rs` (~210) | `type M4 = [f64; 16]` (row-major); `IDENTITY`; `mul`; `transform_point(m, p)` (`m0*p0 + m1*p1 + m2*p2 + m3`, …); `transform_vector(m, v)` (the same without translation; its doc states that on a **column-major** array it computes `Mᵀ·v`, the identity `site_local` relies on); `transpose`; `translation(t)`; `affine_inverse(m) -> Option<M4>` (the cofactor form, `None` iff `det` is non-finite or `abs(det) < SINGULAR_DET_EPS`); `const SINGULAR_DET_EPS = 1e-18` (moves to `math::tol` in F2c); `to_col_major_f32(m) -> [f32; 16]`; `type M3 = [f64; 9]` with `apply3(r, v)`; nalgebra bridges `from_na(&Matrix4<f64>) -> M4`, `to_na(&M4) -> Matrix4<f64>`, `col_major_array(&Matrix4<f64>) -> [f64; 16]`, `to_f32(&M4) -> [f32; 16]` | Two items are `pub(crate)`: `normal_matrix(&Matrix4<f64>) -> Option<Matrix4<f64>>` and `transform_normals_in_place(&mut [f32], &Matrix4<f64>)` (GEOM-11). Their only consumers are inside geometry, and they speak nalgebra. |
| `aabb.rs` (~130) | `#[derive(Clone, Copy, Debug, PartialEq)] struct Aabb3 { pub min: V3, pub max: V3 }`; `EMPTY` (`+INF`/`-INF`); `from_points(impl IntoIterator<Item = V3>)`; `from_f32_positions(&[f32])` (exact widening, complete triplets only); `extend(&mut self, p)`; `union(&self, &Aabb3)`; `overlaps(&self, &Aabb3)` (closed, `<=`); `is_well_formed()` (every axis finite and `min <= max`; this is `geom_bounds.rs:82`'s rule moved, together with its rationale); `to_array6()`, `from_array6()` | `extend` uses `f64::min`/`max`, which skip NaN. That is the behaviour of every fold on main, and it is documented once here. Publishing a box goes through `is_well_formed`. |
| `frame.rs` (~150) | `zup_to_yup<T: Copy + Neg<Output = T>>([T; 3]) -> [T; 3]` (`(x, z, -y)`); `yup_to_zup<T>` (`(x, -z, y)`); `zup_to_yup_in_place(&mut [f32])` (complete triplets only); `aabb_zup_to_yup<T>([T; 6]) -> [T; 6]` (the min/max reversal, moved from `frame_swap.rs:25` with its doc); `conjugate_zup_to_yup(&M4) -> M4` and `conjugate_yup_to_zup(&M4) -> M4` (signed permutation, `+ 0.0` fold); `conjugate3_zup_to_yup(&M3) -> M3`; `ZUP_TO_YUP: M4` and `YUP_TO_ZUP: M4` (the `S`/`Sᵀ` constants, for the products that are not conjugations, e.g. export `S_YUP · native_to_baked`) | The generic point fns serve both the f32 vertex buffers and the f64 origins; they monomorphise in the caller, so they always inline. The "proved once" unit test: `conjugate_*` equals the old matmul over a seeded sweep, compared by `to_bits()`. |

Explicitly **not** in the home, because each has a single consumer and so stays local:
- wasm's render-frame point transform, shared by `grid_lines.rs` and `alignment_lines.rs`. It becomes one `pub(crate)` fn in wasm.
- the server's normals-mismatch decision (§2, server).
- processing's `RigidFrame` (APP-3) and `MeshData::world_corner` (APP-15).
- export's `YUpScratch`.

Also not in the home: an `is_identity` for arrays (its tolerances are F2c's) and a quaternion helper (`gltf.rs:1094` is the only one).

#### 1.2 Visibility and publishing

- Items with at least one consumer in another crate are `pub`. Geometry-only items that speak nalgebra are `pub(crate)`. Nothing is `#[doc(hidden)]`; these are real API.
- **D1:** this is a module in an existing crate. There is no new crate and no publishing plumbing; `CRATES`, `sync-versions` and the path filters are all unchanged.
- **D2:** not affected.
- Every consumer (export, processing, wasm, server, landxml, python) already depends on `ifc-lite-geometry`. This was checked with `cargo tree -i ifc-lite-geometry -e normal`; ffi reaches geometry through processing and needs nothing.

#### 1.3 Conventions the tests pin (`math/*_tests.rs`)

- **Bit equality.** For each fn there is a seeded sweep (xorshift, no new dev-dep). The inputs include ±0, subnormals, 1e7-scale world coordinates, and exact zero rows and columns. The sweep asserts `to_bits()` equality against the expanded formula written out in the test. That expanded formula is the spec, not a copy.
- **Non-finite input.** A separate table asserts the documented canonical behaviour per fn.
- **No FMA.** A test asserts `cross` and `dot` are not fused, using the input pair from `kernel/manifest.rs`'s FMA rationale where `fma(a,b,c) != a*b+c`.

#### 1.4 Semver and rust-major-offset

- F2a is additive in `ifc-lite-geometry`, which cargo-semver-checks accepts as minor. No migration PR removes or changes a `pub` item of a published crate:
  - geometry keeps `compose_instance_world_row_major` and `instance_rel_row_major_f32`;
  - processing keeps `native_to_baked` and `convert_mesh_to_site_local` with unchanged signatures;
  - export's, wasm's and processing's copies are `pub(crate)`/`pub(super)`;
  - `apps/server` is not published.
- So F2a appends **nothing** to `latestBreak`. If a lane finds it must change a `pub` signature, it appends that account to break #11, as the ledger states.

### 2. Every current copy, per crate

R = behaviour-preserving, X = reconcile first (§3). Lines are on `4f3197201f`.

**geometry** (owner of the home)
- **Leaf sites (PR G1):**
  - `clash_contact_axes.rs:37 canonical`, `:52 dot3`, `:56 cross3`, `:81 normalize3` → `v3`. The relative `face_normal` (`:123`) and `MIN_SIN_THETA` stay: they are gate policy. Closes GEOM-15 and EDGE-CLASH-12 (geometry part).
  - `facet_weld.rs:123 tri_normal` → `tri_normal` + `normalize(n, 0.0)`.
  - `mesh_tjunction.rs:35 dist` (`powi(2)`, see §3) and `:47` inline cross → `v3`.
  - `geom_bounds.rs:29-93` accumulators → `Aabb3`, with `world_aabb` = `is_well_formed` (XCUT-8).
  - `zone_split.rs:336 tris_aabb`, the verbatim copy of broadphase's → `Aabb3::from_points`. Same `INFINITY` sentinel (XCUT-8).
- **Instancing and flatteners (PR G1):**
  - `instancing/collate.rs:9 IDENTITY16` → `mat4::IDENTITY`; `collate.rs:28 mat4_to_row_major_f32` → `mat4::to_f32(&from_na(m))`.
  - `router/processing.rs:21 IDENTITY_ROW_MAJOR` → `mat4::IDENTITY`.
  - `router/transforms/mod.rs:100 mat4_to_col_array`, `:108 mat4_to_row_major` → `col_major_array`/`from_na`.
  - The other ROUTER-14 spellings: `router/mod.rs:717`, `router/transforms/mod.rs:289`, `transforms/linear.rs:90`, `transforms/mapped.rs:43`, `analytic/profile.rs:134`, `analytic/extrusion.rs:97`. Closes ROUTER-14.
  - `router/layers.rs:535 matrix_is_identity` → nalgebra `m.is_identity(1e-9)`. This is the copy half of ROUTER-42. The 1e-9 vs 1e-12 (`transforms/mapped.rs:129`) values are F2c's.
- **Router bounds and normals (PR G2, after X1):**
  - `router/transforms/mesh_world.rs:45` (8-corner loop), `:223`, `:242`, `:296` folds → `Aabb3`.
  - `router/frame_parts.rs:78 mesh_bounds`, `:96 union_bounds` → `Aabb3::from_f32_positions`/`union`, cast back to `[f32; 6]`. This is exact (§3). Closes ROUTER-11 outside voids.
  - Normal transforms `mesh_world.rs:361`, `scalar.rs:184` and `instancing/dont_bake.rs:79-96` → `mat4::transform_normals_in_place` (GEOM-11).
  - `instancing/collate.rs:17 compose_world` → `mat4::mul` over the row-major `InstanceMeta` arrays, then `to_na`. With that, `compose_instance_world_row_major` and export's product are one spelling (XCUT-4).
- **Kernel (PR G3, after #7762 merges):**
  - `kernel/tritri.rs:42 sub_f64`, `:46 cross_f64`, `:51 plane_normal`, `:156 ti_dot`. The second copy (`ti_sub`/`ti_cross`) is already gone, so the finding is *stale* there.
  - `kernel/arrangement/classify.rs:17 cross3`, `:20 dot3`, `:85 sub_f64`, `:98 tri_normal`.
  - `kernel/signed_volume.rs:25-36`, `kernel/retriangulate.rs:110-118`, `kernel/retriangulate_cleanup.rs:50-56`, `kernel/mesh_bridge.rs:70 face_plane` (fallback `+Z` stays explicit), `simplify/cavities.rs:161-166`.
  - `kernel/broadphase.rs:38 tri_aabb`, `:116 tris_aabb`, `:235 bounds` → `Aabb3`. Its sentinel moves from `f64::MAX` to `INFINITY` only if the lane shows that no arithmetic reads an empty box (the doc at `broadphase.rs:105-112` says none does). Otherwise broadphase keeps its own type and the lane records why.
  - The exact-arithmetic twins `kernel/rational.rs:50,62` and `kernel/fixed.rs:69,72` are **not** copies: they operate on different number types. They stay.
  - Closes KERNEL-5.
- **Not F2a:**
  - `router/voids/prism_cut.rs:222-265` (the kit), `voids/malformed_opening_repair.rs:228,306`, `voids/coaxial_union.rs:529`, `voids/probe.rs:627-681`, `voids/synthesis.rs:41,285,629`: C2.
  - nalgebra `.cross()`/`.dot()`/`try_normalize` in `csg/normals.rs:66-83` and the processors: interior type, not a copy.
  - `Mesh::bounds` (`mesh.rs:646`): public signature with "origin for empty" semantics. Its body stays a single f32 fold unless G2 shows the `Aabb3` version is Ir-neutral; f64 widening halves the SIMD width.

**processing**
- **Frame and mat4 (PR P1, after X2):**
  - `simplify_math.rs:13 yup_to_zup`, `:20 zup_to_yup`, `:26 conjugate_yup_to_zup` (its `S`/`ST`, the jscpd pair with `frame_swap.rs`), `:45 matmul_row_major`, `:60 transform_point_row_major`, `:70 invert_affine_row_major` → `frame`/`mat4`. `averaged_vertex_normals` stays. Closes PROCESSING-11 and EDGE-CLASH-2 (processing part).
  - `processor/site_local.rs:69-90 native_to_baked` (rotation extraction), `:112 apply_inverse_rotation_in_place`, `:165 apply_inverse_rotation_point_f64` and `mesh_frame.rs:208 rotate_into_frame` → `mat4::transform_vector` on the column-major array. That is `Rᵀ·v` with the same op order. The `rotation_is_identity` guard (`mesh_frame.rs:40`) stays where it is. Closes PROCESSING-10.
  - `analytic_export/definitions.rs:131` → `col_major_array`.
- **v3 and in-crate DRY (PR P2, after X4 and #7752):**
  - `appearance/transfer_math.rs:8 sub`, `:11 dot`, `:14 cross` → `v3`. The two re-exporters (`scan_proposals/frame.rs:9`, `scan_segmentation/normals.rs:14`) import `v3` directly. `scan_proposals/frame.rs:14 add`, `:18 scale`, `:22 norm` → `v3`.
  - `scan_segmentation/normals.rs:16 unit` → `normalize(a, 1e-12)`.
  - `appearance/authored.rs:18 dot`, `:21 cross`; `appearance/mapping.rs:31 dot`, `:34 subtract`, `:193-198` inline cross; `appearance/page_atlas.rs:30-31` closures; `appearance/captured.rs:23` inline; `appearance/calibration.rs:36 dot`, `:84` inline cross → `v3`.
  - Calibration's `:39 length`/`:47 unit` (a `hypot` chain) stay local, with a one-line reason (§3). Closes PROCESSING-12 and PROCESSING-APP-4 (3D half).
  - **APP-3:** `appearance/authored.rs:213-235` and `appearance/evaluated_source.rs:95-108` → one `pub(super) struct RigidFrame` in `transfer_math.rs`, with `try_from(&[f64; 16], scale, require_right_handed)`. The callers pass today's flags, so the drift becomes an explicit argument (R).
  - **APP-15:** `MeshData::world_corner(v, rtc)` in `types/mesh.rs`, with `(p + origin) + rtc`, the order every site already uses. Sites: `appearance/pdf_fill.rs:235`, `annotation.rs:78`, `captured.rs:49`, `transfer_target.rs:48`, `evaluated_source.rs:107`. `evaluated_precision.rs:34-35` has no rtc, so it is a different quantity and stays.
  - **SYM-11:** `pdf_vector/extent.rs:98-104` and `pdf_vector/curve_hulls.rs:53-63` call the existing `extent::bbox`/union.
- **Not F2a:** `pdf_vector/strokes.rs:14-26` and `scan_segmentation/{ring,extent}.rs` P2 helpers are 2D, so they go to F2b. `symbolic/*` f32 normalisation goes to C5/C11.

**export (PR E1, after X2; before C7 starts)**
- `gltf/matrix.rs:33 S_YUP`, `:40 S_YUP_INV`, `:46 IDENTITY16`, `:54 mat4_mul`, `:137 mat4_translation`, `:147 row_major_f64_to_col_major_f32`, `:160 affine_inverse`, `:198 compose_world_meta` → `frame`/`mat4`, and `compose_world_meta` becomes geometry's `compose_instance_world_row_major` (G2 made it the same loop). Closes XCUT-4 and EXPORT-GEOM-3.
- `frame.rs:20 yup_f32`, `:26 yup_f64`, `:40 yup_matrix4`, and the loops at `:91`/`:115` → `frame` (`YUpScratch` stays). The one call in `gltf.rs:1062` changes. Closes XCUT-5 (export part).
- `geom.rs:12 zup`, `:27 dist`, `:232 dot`; `collada.rs:34 to_zup`; `openings.rs:18 sub`, `:19 norm` (→ `normalize(a, 0.0).unwrap_or([0.0; 3])`); `adjacency.rs:24 sub`, `:25 dist` → `v3`/`frame`.
- *Stale:* the test copies `gltf_tests.rs:318` and `examples/world_check.rs:34` no longer exist.
- **Not F2a:** the `gltf.rs` bounds folds (`:659, :767, :1134, :1733, :2166, :2191`), `collada.rs:232` and `usd/emit.rs:161` → C7, which owns `gltf.rs` in waves 3–4. They can use `Aabb3` then.

**wasm-bindings (PR W1, after X3)**
- `zero_copy/frame_swap.rs` is **deleted**. Its users are `zero_copy/mesh.rs:5,331,335` and `zero_copy/mesh_fingerprint.rs:21,94`; they call `frame::aabb_zup_to_yup`/`conjugate_zup_to_yup` instead.
- `zero_copy/mesh.rs:307-326` inline swaps → `frame::zup_to_yup_in_place`/`zup_to_yup`.
- `api/alignment_lines.rs:125 IDENTITY` and the `grid_lines.rs:77-79` literal → `mat4::IDENTITY`.
- `grid_lines.rs:176 to_render_frame` and `alignment_lines.rs:153-161` → one `pub(crate) fn to_render_frame` in wasm.
- The binding surface is unchanged: no `.d.ts`, `api-surface` or changeset. Closes EDGE-WASM-9 and EDGE-CLASH-2 (wasm part).

**apps/server (PR S1)**
- `services/axis.rs:22 zup_to_yup`, `:30 zup_to_yup_f64` → `frame::zup_to_yup`. `mesh_to_yup_in_place` stays: it is the JSON transport's policy.
- `services/parquet_instancing.rs:216-217 P_ZUP_TO_YUP(_T)`, `:219 mat3_mul`, `:236 rotation_zup_to_yup` → `frame::conjugate3_zup_to_yup` plus the f32 cast; `:125 apply_r_t` → `add(mat4::apply3(r, p), t)`.
- The normals-mismatch decision and its warning are written three times (`axis.rs:74-85`, `parquet_vertex_columns.rs:30-41`, `parquet_optimized.rs:224-234`). They become one `fn normals_parallel(&MeshData) -> NormalsState` in `axis.rs`. The *outcomes* stay per format: JSON clears the buffer, while parquet zero-pads because the schema's columns are non-null. That difference is forced by the format, so this is R, and the doc states it once. Closes SERVER-15.
- `IDENTITY_ROTATION: [f32; 9]` stays: it is a wire constant.

**clash (PR C1 R; PR X5)**
- **C1 (R):** move `obb_detect.rs:27 canonical` into a new dependency-free `rust/clash/src/canonical.rs` (MPL header, no `crate::` paths). Geometry's tests compile it through `#[path]` (§4).
- **C1 (R), EDGE-CLASH-8, clash half:** `depth.rs:212` uses the Plato-generated 2^-22. Fix the stale references (`depth.rs:206-207` points at `mesh_bridge`; `near_band.rs:52-53` and `plane_eps.rs:92-93` cite a TS file that does not exist; the geometry-side reference fixes ride G3).
- **X5:** EDGE-CLASH-4's degenerate-normal drift (§3).
- The Plato helpers `vec3.rs` and `aabb.rs` stay, as the charter requires.

**core, ffi, landxml, python: no PR**
- **core** cannot depend on geometry; `core/Cargo.toml:42` has geometry only as a path dev-dep. `ModelBounds` (`model_bounds.rs:16`) has its own validity rule (`sample_count`). `georef.rs:248 to_matrix` is domain code, not a helper copy.
- **ffi:** 0 hits for any pattern.
- **landxml:** `plan/numeric/measure.rs:48 cross` is planar northing/easting with LandXML errors → C9c.
- **python:** 0 hits.

### 3. Drift reconciliation

| Drift | Where | Canonical | Proof / class |
|---|---|---|---|
| **dot summation order** | `iter().zip().sum()` in `transfer_math.rs:12`, `authored.rs:19`, `calibration.rs:37`, `mapping.rs:32` and `page_atlas.rs:31`, vs explicit `a0*b0 + a1*b1 + a2*b2` everywhere else | explicit | On the pinned toolchain (`nightly-2025-11-15`, rustc 1.93), `f64: Sum` folds from `-0.0`, and `-0.0 + x == x` bit for bit, including `x = ±0`. So they are equal for all inputs. The P2 lane pins this with a `to_bits` sweep test that includes all-`-0.0` products. **R.** |
| **`hypot` chain vs `sqrt(dot)`** | `calibration.rs:39 length` | `sqrt(dot)` everywhere else | These are not bit-equal. Calibration's `length` stays local, with a one-line reason: it is a validation measure at a 1 ppm tolerance, and moving it buys nothing. Recorded as a sanctioned exception, not a third copy of `norm`. |
| **`powi(2)` sums** | `mesh_tjunction.rs:35`, `export/geom.rs:27` | `dist` = `norm(sub)` | `powi(x, 2)` lowers to `x*x` (LLVM instcombine; `__powidf2` gives `1.0*(x*x)` for n = 2). Bit-equal, and the sweep test proves it. **R.** |
| **normalise threshold** | `== 0`/`<= 0` (`clash_contact_axes:83`, `facet_weld:132`, `retriangulate_cleanup:54`, `mesh_bridge:79`, `export/openings:21`); `<= 1e-12` (`scan_segmentation/normals:18`, `scan_proposals/frame:28`); `< 1e-12` (`prism_cut:252`) | `normalize(v, min_len)`, `None` iff `!len.is_finite() \|\| len <= min_len`; callers pass their current value (0.0 or 1e-12) | Equal for every finite input at each migrated site. `prism_cut`'s strict `<` differs only at exactly 1e-12 and is C2's. F2c names the values. **R.** |
| **normalise: division vs reciprocal-multiply** | Division in every site except `prism_cut:255` (C2) and `scan_proposals/frame.rs:28` (`scale(a, 1/len)`) | Division | `scan_proposals` changes by up to 1 ulp per component, so it gets **X4** (tiny, processing). Evidence: the scan_proposals tests are tolerance-based; the lane reports that no pinned output moved. `prism_cut` stays untouched until C2, whose fingerprint run decides it. |
| **NaN and inf in normalise** | `facet_weld:132`, `retriangulate_cleanup:54` return `Some(NaN)`; `export/openings:21` returns zero for NaN and `a/inf` for inf; `scan_proposals unit` passes NaN through | `None` (non-finite length) | Reachable only from non-finite positions. Those are refused at decode after #7752 (S6a) and at output after #7767 (S6b). Migrations that depend on this land **after #7752 merges**, and each adds a unit test pinning NaN → `None` → the call site's fallback. Byte-identical on the corpus, so **R** with the justification stated in the PR. |
| **degenerate fallback** | `+Z` (`mesh_bridge:84`, `csg/normals:83`), zero vector (`openings`), the input itself (`scan_proposals unit`), `None`/`Err` elsewhere | No fallback is unified. Each becomes an explicit `.unwrap_or(..)` at its site | This is the point of the change: the policy becomes visible. **R.** |
| **affine-inverse singularity** | `export/gltf/matrix.rs:166`: `abs(det) < 1e-18`, no finiteness check, so a NaN placement returns `Some(NaN)` and NaN node matrices ship; `processing/simplify_math.rs:75`: `!finite \|\| < 1e-24` | `!det.is_finite() \|\| abs(det) < 1e-18` | **X2**, one PR touching both copies before E1/P1. Regression tests: (a) a NaN placement makes glTF fall back to flat (EXPORT-GEOM-3); (b) `det` in `[1e-24, 1e-18)` returns `None` in the demesher. The cofactor arithmetic is token-identical in the two copies (checked), so only the threshold moves. Export goldens are re-pinned only if a format moves (none expected; the corpus has no such placement). |
| **normal-matrix singular policy** (GEOM-11) | `mesh_world:361`/`scalar:184`: 4×4 `try_inverse().unwrap_or(M).transpose()`, then `normalize()`, so NaN for a zero result; `dont_bake:79-96`: a 3×3 inverse (different bits), `unwrap_or(linear)` without transpose, then `try_normalize(0.0).unwrap_or(nv)` | The flat path's numerics (4×4 inverse-transpose, the hot path that every placed mesh takes) with **zero normals on a singular transform or zero result, never NaN** | **X1** before G2. Non-singular output is unchanged: `normalize()` and `try_normalize(0.0)` both divide by the same norm. Changes: singular transforms (zero-scale `IfcCartesianTransformationOperator`) now give zero normals instead of NaN or `Mᵀ`-skewed ones, and the rare orphan `dont_bake` path now matches the flat bake bit for bit. Regression test first; fingerprint delta listed. |
| **sign of zero in conjugation** | Matmul copies (`frame_swap.rs:49`, `simplify_math.rs:45`, `parquet_instancing.rs:219`) emit `+0.0` for every zero; `export/frame.rs:40 yup_matrix4` (permutation) emits `-0.0` | Permutation plus a `+ 0.0` fold | For finite input this is bit-equal to the matmul copies: each output is `0.0 + (±0)… + (±m)`, which is exactly `±m`, with zeros to `+0`. Proven by a sweep test. wasm, processing and server are **R**. For export, `yup_matrix4` feeds `scene_root`'s quaternion (`gltf.rs:1062-1080`), where a zero's sign can reach the glTF JSON. E1 runs the golden corpus: if `glb`/`gltf` move only in zero sign, E1 is reclassified X and re-pins those two formats, with the reason "one frame convention, matching wasm and server". Non-finite matrices give a localised NaN instead of a NaN row; they are refused upstream (S6a). |
| **sign of zero in the render-frame point** (EDGE-WASM-9) | `grid_lines.rs:202` adds `+ 0.0` (parity with the symbolic overlay's goldens); `alignment_lines.rs:160` emits `-my as f32` | Grid's: fold to `+0.0` | **X3**, wasm: alignment adopts the fold through the shared fn. Test: a zero-northing alignment emits `+0.0`. Binding behaviour changes, so a `pnpm changeset` (patch) is needed; the signature does not change, so no `.d.ts`. |
| **row- vs column-major** | export: `frame.rs` is column-major and `gltf/matrix.rs` row-major; processing `site_local` reads a column-major site matrix | `mat4` is row-major only | Conjugation is storage-agnostic (proven in the test: `conj(transpose(M)) == transpose(conj(M))`). Column-major enters only through `transpose`, `col_major_array`, or `transform_vector`'s documented `Mᵀ·v` identity. That identity is exactly what `native_to_baked`'s comment already states: "the ROWS of the row-major result are the COLUMNS of the column-major site matrix". **R.** |
| **4×4 product spelling** | `collate.rs:17 compose_world` (a nalgebra product, no 0.0 accumulator) vs export `compose_world_meta` (the loop) | The loop (`mat4::mul`) | The two can differ only in the sign of an all-zero dot product. G2 switches `compose_world` to `mat4::mul`; E1 then calls geometry's pub fn and is byte-identical by construction. Evidence for G2: the instancing tests, export `instanced_*`, server parity and the wasm32 `mesh_determinism` manifest. If a pinned output moves, G2 is reclassified X with the re-pin. |
| **AABB empty sentinel** | `INFINITY` (`zone_split`, `frame_parts`, `gltf`); `f64::MAX` (`broadphase:112`, `malformed_opening_repair:228`); origin (`Mesh::bounds`); `None` (`geom_bounds`) | `Aabb3::EMPTY` = `±INFINITY`; empty → `None` decided at the call site | Equal wherever no arithmetic reads an empty box (`overlaps`, `contains` and `min`/`max` all behave the same with MAX and INF). For broadphase, see §2. `Mesh::bounds`'s origin result is public API and stays. |
| **f32 vs f64** | `frame_parts` and wasm `local_bounds` are f32 boxes | `Aabb3` is f64, built with `from_f32_positions`, cast back | f32→f64 is exact, and `min`/`max` of exactly representable values cast back exactly. Bit-equal, so **R**. `to_col_major_f32` and `to_f32` are the only f64→f32 points (B5 rule). |
| **handedness** | `S` is a proper rotation (det +1) in every copy: `(x, z, -y)` and the inverse `(x, -z, y)`. APP-3: `authored.rs:225` requires right-handed frames, `evaluated_source.rs` accepts mirrored ones | No drift in the frame. For APP-3, an explicit `require_right_handed` argument | **R.** Whether `evaluated_source` should also refuse mirrored frames is an open product question, noted in the PR rather than changed. |
| **clash degenerate normal** (EDGE-CLASH-4) | `clash/obb_detect.rs:16-22` drops a face when `\|e1×e2\| <= 1e-6` m² (fixed, not scale-free), so a 1 mm × 1 mm box face loses its family and `detect_obb` returns `None`, which gives an `Estimate` depth. Geometry uses the scale-free `MIN_SIN_THETA` | Scale-free: the `sin θ` test | **X5**, clash plus TS (D5): the change goes in `tools/plato/clash_math.plato`, then regenerated Rust and TS, plus a parity vector. Verify-first: the 1 mm box returns `None` at base and `Some` at head. The family-merge tolerances (`obb_detect:156` vs `ORTHO_EPS`) serve different purposes; they are documented, not unified (as the finding says). |

**Every R PR's evidence (charter §1.2)**
- **(a)** `perf_probe --fingerprint`, byte-identical over the named corpus.
- **(b)** The insta snapshots are unchanged.
- **(c)** `mesh_determinism`.
- **(d)** The T3 oracles for every output the crate can reach:
  - export: all 11 `golden/<format>.json`;
  - server: the `oneshot` route hashes;
  - processing: the Python wheel JSON;
  - wasm: the wasm32 determinism manifest and `pnpm test:wasm-contract`.
- **(e)** For instancing and frame changes: export `instanced_*`, server parity, and the manifest's material/style hashes.
- **(f)** The perf verdict (§7).

### 4. The clash/geometry seam: keep the clone, add a parity test

**Measured:**
- **Direction and cycles.** `cargo tree -i ifc-lite-clash -e normal` shows `ifc-lite-wasm` is clash's **only** normal dependent. Clash has empty `[dependencies]` and no dev-dependencies. Geometry → clash would therefore be acyclic. Clash's existing *versioned* dev-dep already forces clash to publish before geometry (`scripts/lib/crates-io.mjs`), so publish order would not change.
- **Wasm size: zero difference either way.** The wasm bundle already links clash (wasm → clash). The 14 lines LTO-inline identically wherever they live.
- **Compile and dependency footprint.** Clash's production code is about 3.1k lines (non-test `src/`). A normal edge would add it to the build of every crate that does not have it today: processing, ffi, server, landxml, export and python. It would also add a dependency line to geometry's crates.io manifest.
- **API.** Clash exports no math today; its `vec3` and `obb_detect` modules are private. Promoting the dependency would mean a new `pub fn canonical` in clash: published API created only for geometry. That item is also TS-parity-locked (`packages/clash/src/engine-ts/obb-detect.ts:27`), so geometry could never change its own copy independently.
- **Semantics.** Geometry's `canonical` dedups antipodal face families for `clash_solid`'s thickness gate (`clash_contact_axes.rs:37`, used in `gate_axes`). That gate has **no TS twin**: the renderer only draws the Rust solid (`grep` for `gateAxes`/`intersectionSolid` across `packages/` finds only the overlay wiring). Clash's `canonical` feeds `detect_obb`, which must match TS bit for bit. The two have different contracts that happen to share a rule.

**Decision: keep the separate definitions.**
- Geometry's becomes `math::v3::canonical`.
- PR C1 extracts clash's into `rust/clash/src/canonical.rs`. That file is dependency-free with no `crate::` paths, the same constraint as `world_frame_corpus.rs`.
- G1 adds `#[cfg(test)] #[path = "../../../clash/src/canonical.rs"] mod clash_canonical;` under `math/` and a parity test. The test asserts `to_bits` equality of the two over the tie cases (`|x| = |y|`, `|y| = |z|`, all equal), ±0 in every slot, NaN in every slot, and a seeded sweep.
- `#[path]` is used in tests only. In production it would break `cargo publish` of geometry, because the packaged crate does not contain `../clash`. That is also the reason `world_frame_corpus.rs` is shared this way (its header records the same three alternatives).
- Precedent is #5406. The "same rule as the sibling" comment (`clash_contact_axes.rs:36`) is replaced by a pointer to the test.

This closes EDGE-CLASH-4's seam half and the clash/geometry bullet of XCUT-19. The rest of XCUT-19 is not math: the landxml work limit re-derived in `wasm-bindings/src/api/landxml/endpoints.rs:259`, the `profile_extractor` placement fork, the terrain CDT, and the bench replay clone. It is re-mapped (§"Needs").

### 5. Migration order and hot-file conflicts

Branches are `sweep/f2a-<tag>`. Sonnet lanes do the R migrations; Opus does G1 and the X PRs.

| # | PR | Class | Crate | Depends on | Est. changed lines | Conflicts / ownership |
|---|---|---|---|---|---|---|
| 1 | **C1** canonical extraction + EDGE-CLASH-8 clash half | R | clash | none | ~80 | none |
| 2 | **G1** the home + geometry leaf sites + parity test | R (G-lite) | geometry | C1 | ~1,300 (≈550 prod, ≈450 tests, −300 deleted) | none open; it touches `router/transforms/*`, so it must merge **before F3b starts** (F3b depends on F2a anyway) |
| 3 | **X1** GEOM-11 normal-matrix policy | X | geometry | none (runs in parallel with G1) | ~150 | `mesh_world.rs`, `scalar.rs`, `dont_bake.rs`: no open PR |
| 4 | **X2** affine-inverse singular policy | X | export + processing | none | ~120 | `gltf/matrix.rs`, `simplify_math.rs`: no open PR |
| 5 | **X3** wasm alignment `-0.0` | X | wasm | none | ~60 + changeset | none |
| 6 | **X4** scan_proposals `unit` division | X | processing | none | ~30 | none |
| 7 | **X5** clash scale-free degenerate normal | X | clash + TS | C1 | ~150 | Plato regeneration; the TS twin is in the same PR (D5) |
| 8 | **G2** router bounds, normals, `compose_world` | R (X if §3 says so) | geometry | G1, X1 | ~400 | `router/transforms/*` is read by F3b, so G2 merges before F3b; never `router/voids/*` (C2) |
| 9 | **G3** kernel vec3 / tri_normal / broadphase AABB | R | geometry | G1, **#7762 merged** (`kernel/mesh_bridge.rs`) | ~350 | dispatch `determinism.yml`; must merge **before C3** starts |
| 10 | **P1** processing frame/mat4 | R | processing | G1, X2 | ~300 | #7752 touches `processor/{mod,jobs,diagnostics,...}.rs` but not `site_local.rs` or `mesh_frame.rs`; rebase after it |
| 11 | **P2** processing v3 + APP-3/APP-15/SYM-11 | R | processing | G1, X4, **#7752 merged** | ~500 | `appearance/*`, `pdf_vector/*`, `scan_*`: no open PR |
| 12 | **E1** export | R (X if glTF zero-sign moves) | export | G1, G2, X2 | ~450 | it touches `gltf.rs` only at `:1062`; must merge before C7 takes `gltf.rs` (wave 3) |
| 13 | **W1** wasm (`frame_swap.rs` deleted) | R | wasm | G1, X3 | ~200 | #7752 touches `api/gpu_meshes/*` and `api/zone_split.rs`, not `zero_copy/*` or `api/{grid,alignment}_lines.rs` |
| 14 | **S1** server | R | apps/server | G1 | ~250 | S4/C8 own `apps/server/src/routes/*`; S1 touches only `services/{axis,parquet_*}.rs` |

Parallelism:
- **Wave 2:** C1, X1–X5 and G1 (Opus, in parallel).
- **Wave 2 → 3:** G2, G3, P1, P2, E1, W1 and S1 as Sonnet lanes, at most 6 at once, all independent of each other except E1, which needs G2.

**G3 (gate):** it lands with the last F2a/F3/F4 migration and adds **one** grep for the spellings that were actually copied. That grep bans `fn (dot3?|cross3?|sub3|matmul\w*|mat4_mul|mat3_mul|zup_to_yup\w*|yup_to_zup\w*|swap_zup\w*)\b` in non-test `rust/*/src` and `apps/server/src`, with these exceptions:
- `rust/geometry/src/math/`;
- `rust/clash/` (Plato);
- `kernel/{rational,fixed}.rs` (exact number types);
- `router/voids/prism_cut.rs`, until C2 removes it from the list.

### 6. Stop line

- **Required, because they close the High findings and every cross-crate copy:** C1, G1, X2, P1, E1, W1, S1. After these, no crate outside geometry carries vector, matrix or frame math, and the frame has one definition (XCUT-3, XCUT-4 and XCUT-5 are closed).
- **Required for correctness, though independent of the home:** X1 (NaN normals) and X2 (NaN node matrices). X5 is a user-visible clash fix and should not be dropped silently. If it stalls, EDGE-CLASH-4 stays open in the ledger.
- **Optional:** G2, G3, P2, X3, X4.
  - **Why these can stop:** their copies are *inside* one crate. Geometry's internal copies live in the crate that owns the home, so they cannot spread to a third crate. P2's copies are inside processing and become private uses of `v3` one file at a time.
  - **C3 can absorb G3.** C3 owns the kernel next; its ledger rows become `fixed-by:` the C3 PR.
  - **Ledger if stopped:** G2's rows go to C2 (voids plus router bounds).
- **If migration stalls at crate N:**
  - Each crate PR is all-or-nothing for that crate, and each reverts cleanly. The home's `pub` items are additive and stay; they are never deleted.
  - A stalled crate keeps its *old* copies untouched. Its copies are never "half moved", so there is never a third spelling.
  - **Safe to delete at any point, independent of order:** `frame_swap.rs` (W1), `simplify_math.rs`'s matrix half (P1), `gltf/matrix.rs`'s helpers (E1), `axis.rs`'s two swaps (S1). Each has only crate-local callers.
  - **Not safe to delete before C2:** the `prism_cut` kit. It is pinned through the determinism manifests and owned by C2.
  - The foundation PR G1 itself replaces at least 15 geometry copies, so the home never sits as a net-new copy.

### 7. Perf risks and how the ratchet covers them

- **Cross-crate inlining.**
  - `release` and `profiling` set `lto = true` and `codegen-units = 1`, so cross-crate inlining is available.
  - Every `v3`, `mat4` and `frame` fn is `#[inline]` anyway, for the non-LTO dev/test builds and for `perf_probe`'s profiling build. The generic `frame` fns monomorphise in the caller.
  - Geometry already builds `opt-level = 3` in dev (`Cargo.toml:104`).
  - `Option`-returning `normalize` compiles to the same branch once inlined.
- **Kernel hot loops (G3).** These are `tritri`, `classify`, `retriangulate*`, `mesh_bridge` and `broadphase`.
  - The op order is identical, so the codegen should be identical.
  - **Gates:** the CI `native-instructions` job (FZK-Haus, per phase, 0.05% tolerance); the lane runs `scripts/perf/instructions.sh --set large` locally (ISSUE_129, the CSG-heavy fixture); and `probe.sh` base vs branch, interleaved.
  - `determinism.yml` is dispatched.
  - Broadphase's `Aabb3` must keep the BVH node layout. Its size is unchanged: two `[f64; 3]`.
- **f32 bounds folds.** Widening to f64 halves the SIMD width. `Mesh::bounds` stays f32 unless G2's callgrind table shows the geometry phase within 0.05%. The `frame_parts` and wasm boxes are per-mesh and cold.
- **Frame conjugation.** The permutation replaces a 2×64-multiply matmul per instance matrix, so it can only get faster. wasm `MeshDataJs::new`'s per-vertex loop becomes `zup_to_yup_in_place` with the same body.
- **Bundle.** W1/E1/P1 dedupe code in the wasm binary, so the size should shrink or stay neutral. The `engine-wasm-brotli` ratchet (0.5%) gates it.
- **Instancing (G2's `compose_world` switch).** It runs per occurrence, not per vertex. It is covered by `native-instructions.geometry` and the server parity tests.

### 8. Docs touched

- **`rust/AGENTS.md`:** one new bullet. "Vector, matrix, frame and AABB math over arrays lives in `ifc_lite_geometry::math`. `nalgebra` is geometry's internal type. Never add a local `dot`/`cross`/`matmul`/`zup_to_yup`; the G3 grep enforces this."
- **`rust/geometry/src/lib.rs:70-75`:** the module-visibility comment (9 `pub` modules).
- **`docs/architecture/coordinate-handling.md`:** a short paragraph naming `math::frame` as the one Z-up → Y-up definition, covering points, AABB reversal and matrix conjugation. This replaces the "in one place" claims in `frame_swap.rs:5` (file deleted) and `services/axis.rs`'s "THE ONE definition" doc (trimmed to the JSON policy). It also fixes `simplify_math.rs:24-25`'s stale pointer to `zero_copy::mesh::swap_zup_to_yup_mat4`.
- **`docs/architecture/mesh-determinism.md`:** one line saying that `math::v3`/`mat4` are FMA-free with a pinned op order, and that kernel callers rely on this.
- **`docs/architecture/plato-codegen.md`:** one line saying clash's `canonical` lives in `canonical.rs` and is parity-tested against geometry's. X5 updates the Plato section for the new degenerate test.
- **`docs/architecture/clash-detection.md:170`:** still accurate (`MeshDataJs::new` remains the call site); no change.
- **`docs/architecture/pure-rust-csg-kernel.md`** does not exist on main; nothing to touch.
- **In code:** the comment truths at `clash_contact_axes.rs:36`, `depth.rs:206-207`, `near_band.rs:52-53` and `plane_eps.rs:92-93` are fixed in their PRs.

### 9. What F2b and F2c build on

**F2b (geom2d predicates)**
- `math` deliberately has no `v2`.
- F2b moves `geom2d.rs` (crate-private, 146 lines) to `math/geom2d.rs` as `pub(crate)`, under the same contract stated in `math/mod.rs`: FMA-free, explicit op order, an explicit `min_len`/eps argument, and NaN behaviour per fn.
- **Ownership.** F2b takes the 2D halves of XCUT-3, PROCESSING-12 and PROCESSING-APP-4 (`processing/pdf_vector/strokes.rs:14-26`, `scan_segmentation/{ring,extent}.rs`, `geometry/scan_outline/topology.rs:358-363`), plus PROC-S8's 2D half. It decides whether processing's three 2D sites justify a `pub` `math::v2`. Recommendation: only if two or more processing files would use it.

**F2c (tolerance catalogue)**
- F2a leaves every tolerance as an explicit argument or a single named constant. The one exception is the affine singularity threshold, which must be one value because the fn is one fn (X2).
- F2c creates `math::tol` and moves or names these, with units:
  - `SINGULAR_DET_EPS` (1e-18, a length³ determinant);
  - the `normalize` `min_len` values (0, 1e-12, and the 1e-6 `csg/normals` `try_normalize`);
  - the identity epsilons (`layers` 1e-9, `mapped.rs:129` 1e-12, `mesh_frame.rs:22` 1e-9, `gltf.rs:1067` 1e-9). This is the value half of ROUTER-42.
  - `ORTHO_EPS`/`MIN_SIN_THETA` (dimensionless);
  - the f32-ULP 2^-22 (`near_band.rs:54`, `csg/plane_eps.rs:96`, `retriangulate_cleanup.rs:60`). This is the geometry half of EDGE-CLASH-8.
- F2c's unit-aware policy for C3 then has one place to change each value.

---

### Needs a decision

Coordinator decisions to record (proposed D21–D24; all are within the charter):
- **D21:** the clash/geometry seam keeps two definitions plus a `#[path]` parity test, not a normal dependency (§4).
- **D22:** the affine-inverse singular policy is `!finite || abs(det) < 1e-18` for both glTF and the demesher (X2).
- **D23:** a singular or zero normal transform writes zero normals, never NaN (X1).
- **D24:** frame conjugation folds the sign of zero to `+0.0` (wasm/server/processing behaviour), and point swaps never fold. The wasm alignment overlay adopts grid's `+0.0`.

Ledger re-maps (coordinator):
- XCUT-19's non-math bullets:
  - `profile_extractor` fork → C2;
  - landxml work limit (`wasm-bindings/src/api/landxml/endpoints.rs:259` vs `landxml/src/stream/derived/plan.rs:242`) → C9a;
  - terrain CDT → C13;
  - bench replay clone → L-geometry.
- The 2D halves of XCUT-3, PROCESSING-12 and APP-4 → F2b.
- EDGE-CLASH-8's geometry half and ROUTER-42's values → F2c.
- The `prism_cut` kit and the voids AABB folds → C2.
- The `gltf.rs`/`collada.rs`/`usd` bounds folds → C7.

Maintainer: nothing blocking.
- **FYI 1:** X5 changes clash output for very small boxy members: `Mesh` certified depth instead of `Estimate`. This is visible in clash results, and the TS twin changes in the same PR.
- **FYI 2:** X1 changes shading only for degenerate (zero-scale) mapped items.

Docs touched: `rust/AGENTS.md`, `rust/geometry/src/lib.rs` (comment), `docs/architecture/{coordinate-handling,mesh-determinism,plato-codegen}.md`.
