# Geometry crate (misc modules, lib.rs, Cargo, tests) review

Scope: `rust/geometry/src/` minus router/, processors/, profiles/, kernel/, csg/, cdt(.rs, /), simplify/, facet_weld.rs, mesh.rs, extrusion.rs, rect_fast(.rs, /), profile_extractor.rs, material_layer_index.rs, alignment.rs, void_index.rs. Also `rust/geometry/Cargo.toml`, `fuzz/`, `examples/`, and the test suite (128 `tests/*.rs` binaries plus 60+ `src/**/*_tests.rs`). Paths are repo-relative. Sites outside my area are listed wherever the canonical home for a concept lives in my area (transform.rs, triangulation.rs, geom2d.rs, union_find.rs, grid.rs and so on), so the lead can dedup against other reports.

## Summary
- **IFC entity-decoding primitives are copied all over the tree.** About 48 inline `coords.get(i).and_then(as_float).unwrap_or(0.0)` triples read IfcCartesianPoint / IfcDirection across geometry, processing, core and wasm, even though `transform::parse_cartesian_point` / `parse_direction` exist. At least 9 `IfcAxis2Placement3D` attribute readers exist, three of them named `parse_axis2_placement_3d`. They have already drifted: a `$` Location is an error in one and the origin in another, and one silently uses the origin when the point fast path fails.
- **The test suite is the biggest DRY debt.** `read_fixture` has 28 copies with 27 different bodies. `build_void_index` has 23 copies, `mesh_volume` / `signed_volume` 27, open-edge / watertight counters 40+ (keyed by bit-exact, 1e-4 grid, 1e-6 weld or position-weld), and box-mesh builders 35+ (`boxed(min,size,rot)` alone 7 times). `tests/support/mod.rs` holds a single function. The `IFC_LITE_REQUIRE_FIXTURES` gate is honoured by only about 37 of the fixture-backed files; the rest still skip silently.
- **Real bug (CONFIRMED):** `triangulation::calculate_polygon_normal` takes its quad normal from vertices 0-1-2. For a concave quad with the reflex vertex at 1 this returns the reversed normal: the exact case `quad_indices` documents and fixes for the 2D split. The faceted-BREP fast path (`processors/brep/faceted.rs:143-188`) also fans every 4-gon from vertex 0 with no convexity test, re-introducing the broken 0-2 split that `quad_indices` exists to prevent.
- **Real bug (LIKELY):** the `SpacePlate` / `space_dcel` editing API (wasm `SpacePlateHandle`) never validates finiteness. NaN coordinates reach two places:
  - `sort_by(partial_cmp().unwrap_or(Equal))` comparators, which since Rust 1.81 may panic on a non-total order. Under `panic=abort` that aborts the wasm worker.
  - `add_face`, which persists NaN rooms because every `< EPS` guard is false for NaN.
- **`lib.rs` public surface is about 3x wider than its users need.** 60 root re-exports have zero users anywhere outside `rust/geometry/src`, and about 20 more are used only by geometry's own integration tests. The module-visibility comment ("only 8 modules ... must stay pub") is stale: 16 are `pub`. The crate-level rustdoc example uses APIs that do not exist (`Profile2D::rectangle`, `extrude_profile(&p, direction, 3.0)`, `router.process`).
- **Cross-cutting runtime switches and telemetry have no home:**
  - 13 `IFC_LITE_*` env flags with four different truthiness semantics. `IFC_LITE_LOCAL_FRAME=0` turns the feature ON; `IFC_LITE_HALFSPACE_CAP_OFF=0` turns the cap OFF; one flag uses the `IFCLITE_` prefix.
  - About 10 independent process-global or thread-local counter systems with `take_*` drains, five of them re-exported from the crate root.
- **Several 2D/3D math and mesh concepts are re-implemented next to their canonical home:**
  - point-in-polygon: 8 copies;
  - signed shoelace area: 6+ copies;
  - union-find: 4 inline copies beside `union_find.rs`;
  - `tris_aabb`: 3 copies;
  - inverse-transpose normal transform: 3 copies whose degenerate handling differs (NaN vs zero normal);
  - f32-ULP noise scale: 9 spellings (2^-20 / 2^-21 / 2^-22 / 2^-23 x6);
  - "find IFCPROJECT and read its length unit": 6+ scanners, two of them verbatim in geometry while `EntityDecoder::length_unit_scale()` already caches the answer.
- **The geometry `[lints.clippy]` block is mostly justified** (numeric-kernel structure lints), but two allows are blanket where a handful of local ones would do: `too_many_arguments` has 12 offenders crate-wide and `should_implement_trait` 4. Ten redundant local `#[allow]`s sit under the crate-wide ones.

## Findings

### GEOM-1: Inline IfcCartesianPoint / IfcDirection coordinate decoding duplicated ~48 times across crates
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: canonical homes `rust/geometry/src/transform.rs:159` (`parse_decoded_cartesian_point`) and `:286` (`parse_direction`). Copies:
  - inside the canonical file itself: `transform.rs:176-178`, `:214-216`, `:303-305`;
  - `rust/geometry/src/processors/helpers.rs:114`, `:140`, `:222`;
  - `rust/geometry/src/curve_segment.rs:112`;
  - `rust/geometry/src/curve_source.rs:130-148` (`mesh_line_basis`, twice);
  - `rust/geometry/src/processors/advanced_face/polyline.rs:103`, `:145`, `:159`, `:202`, `:250`;
  - `rust/geometry/src/processors/advanced_face/curves.rs:22`, `:138`;
  - `rust/geometry/src/processors/advanced_face/edge_loop.rs:304`;
  - `rust/geometry/src/processors/advanced_face/bspline_parse.rs:77`;
  - `rust/geometry/src/processors/advanced_face/conics.rs:26`, `:35`;
  - `rust/geometry/src/processors/advanced_face/revolution.rs:51`, `:62`;
  - `rust/geometry/src/processors/swept/revolved.rs:103`, `:119`;
  - `rust/geometry/src/processors/sectioned_positions.rs:169`;
  - `rust/geometry/src/router/transforms/parsers.rs:93`, `:119`;
  - `rust/geometry/src/router/transforms/operator.rs:72`, `:248`;
  - `rust/geometry/src/profile_extractor.rs:671`;
  - `rust/geometry/src/profiles/mod.rs:802`, `:815`;
  - `rust/geometry/src/profiles/curves_3d.rs:91`, `:130`, `:377`, `:428`, `:499`;
  - `rust/geometry/src/alignment.rs:364`;
  - `rust/processing/src/symbolic/fill.rs:152`, `:165`;
  - `rust/processing/src/symbolic/items.rs:160`, `:198`;
  - `rust/processing/src/symbolic/transform.rs:222`, `:247`;
  - `rust/processing/src/symbolic/operator.rs:66`;
  - `rust/core/src/schema_gen.rs:205`, `:281`;
  - `rust/wasm-bindings/src/api/grid_lines.rs:162`.

  Strict variants that deliberately reject bad input:
  - `rust/geometry/src/curve_source.rs:24` (`point_values`);
  - `rust/geometry/src/alignment_sampling_placement.rs:78` (`validate_vector`).
- What: every site hand-rolls `coords.get(0..3).and_then(|v| v.as_float()).unwrap_or(0.0)`. They differ in:
  - minimum length: `point_values` requires 2 coordinates, `validate_vector` exactly 3, everything else accepts 0;
  - finiteness checking: only the two strict variants check it;
  - IFC type check: some check it, `get_cartesian_point_fast` is "type-agnostic";
  - output precision: f32 vs f64.

  The `IfcDirection` "normalise or default" rules also differ: `try_normalize(1e-9)`, `try_normalize(1e-12)`, or no normalisation at all.
- Why it matters: a malformed point silently becomes `(x, 0, 0)` in some paths and an error in others, so geometry and analytic descriptions of the same entity can disagree. Any future policy change (e.g. reject non-finite) has to be applied in about 48 places.
- Fix: put two decoders on `ifc_lite_core::DecodedEntity` or in `geometry::transform`:
  - `coords3_lenient(&self, attr) -> [f64; 3]`;
  - `coords3_strict(&self, attr) -> Result<[f64; 3]>`, with an explicit policy enum.

  Route every site through them and delete `curve_source::mesh_line_basis`'s inline copies.
- Effort: M

### GEOM-2: Nine IfcAxis2Placement3D attribute readers, already drifted (Location `$`, error swallowing, fast-path fallback)
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/transform.rs:26` (`parse_axis2_placement_3d`);
  - `rust/geometry/src/transform.rs:233` (`parse_axis2_placement_3d_from_id`);
  - `rust/geometry/src/processors/helpers.rs:31` (`parse_axis2_placement_3d`, the same name);
  - `rust/geometry/src/processors/helpers.rs:172` (`get_axis2_placement_transform_by_id`);
  - `rust/geometry/src/profile_extractor.rs:603` (`parse_axis2_placement_3d`, a third same-named copy);
  - `rust/geometry/src/router/transforms/parsers.rs:25-56`;
  - `rust/geometry/src/processors/advanced_face/conics.rs:13` (`read_axis2_placement_3d`);
  - `rust/geometry/src/profiles/curves_3d.rs:64` (`read_conic_placement_3d`);
  - `rust/geometry/src/profiles/mod.rs:782`;
  - `rust/geometry/src/curve_segment.rs:101` (`read_placement`).

  2D readers: `rust/geometry/src/transform/placement_2d.rs:14`, `rust/geometry/src/profiles/placement.rs:214`, the 2D branch of `rust/geometry/src/curve_source.rs:188` (`circle_basis`), and `rust/processing/src/symbolic/transform.rs:193`.
- What: `build_axis2_matrix` (`transform.rs:79`) was introduced so the orthonormalisation "can never drift out of a fork". The attribute extraction above it is still forked, and it has drifted:
  - `transform::parse_axis2_placement_3d` errors on a `$` Location (it calls `parse_cartesian_point`, which errors on an unresolvable ref).
  - `helpers::parse_axis2_placement_3d` maps `$` to the origin.
  - `_from_id` maps a missing or non-ref Location to the origin, but propagates direction decode errors.
  - `helpers::get_axis2_placement_transform_by_id` swallows every error (`.and_then(..).unwrap_or(...)`). It reads Location only via `get_cartesian_point_fast`, so when the fast path returns `None` (any point the raw scanner cannot parse) the placement silently snaps to the origin.
  - In `transform.rs`, the Z-axis and RefDirection extraction is the same 14-line nested `if let` written four times (`:33-60`, `:249-277`).
- Why it matters: the same IFC placement can yield different matrices depending on which processor reads it. The silent origin fallback in `helpers.rs:181-185` misplaces geometry with no diagnostic.
- Fix: keep one `read_axis2_placement_3d(entity, decoder, policy) -> Result<(Point3, Vector3, Vector3)>` in `transform.rs`, with `Strict` / `Lenient` policy. Make every caller use it with `build_axis2_matrix`, and remove the same-named private copies.
- Effort: M

### GEOM-3: `calculate_polygon_normal` returns a reversed normal for concave quads; faceted fast path fans concave quads across the outside diagonal
- Category: Bug
- Severity: High
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/triangulation.rs:482-505` (quad path `if n <= 4`, `v1 = p1-p0, v2 = p2-p0`);
  - `rust/geometry/src/processors/brep/faceted.rs:143-188` (fast path: `is_convex` defaults to `true`, and the convexity test runs only `if n > 4`);
  - callers of the normal: `rust/geometry/src/processors/brep/faceted.rs:201`, `rust/geometry/src/processors/advanced_face/surfaces.rs:47`, `rust/geometry/src/processors/advanced_face/bounds.rs:86`.
- What: for the dart `[(0,0),(2,2),(4,0),(2,10)]` that `quad_indices`' own doc (`triangulation.rs:222-254`) uses, the ring winds CCW (+16 area), but `(p1-p0)x(p2-p0)` has z = -8, so the returned normal is -Z. The slow path then:
  1. projects with that flipped basis (`project_to_2d`), mirroring the ring;
  2. earcuts it (earcutr re-winds CCW in the mirrored frame);
  3. emits triangles wound opposite to the face.

  Separately, faceted's 3D fast path emits `(0,1,2),(0,2,3)` for every 4-gon without holes. That is precisely the split `quad_indices` was written to replace: one triangle is backwards and outside the face, and the other covers that region twice.
- Why it matters: concave quads (darts, arrow or chevron faces, notch facets in faceted BREPs) render with inverted or overlapping triangles. A concave quad with an inner loop goes through the flipped-normal path. The 2D fix in `quad_indices` never reached either 3D path.
- Fix:
  - Use Newell's method for every `n >= 3` in `calculate_polygon_normal`. It is cheap and orientation-correct for concave rings.
  - In `faceted.rs`, route `n == 4` through the same reflex test as `quad_indices`: export a 3D variant `quad_split_3d(points, normal)` from `triangulation.rs`, or project and call `triangulate_polygon`.
  - Add the dart as a faceted-BREP regression.
- Effort: S

### GEOM-4: `read_fixture` re-implemented 28 times (27 distinct bodies); `IFC_LITE_REQUIRE_FIXTURES` honoured only by ~37 files
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - `read_fixture` in: `rust/geometry/tests/issue_953_trimmed_curve_cartesian.rs:56`, `issue_846_revolved_beam.rs:21`, `issue_1910_building_geometry_rtc.rs:60`, `issue_1164_swept_disk_trimmed_line.rs:20`, `nested_mapped_item.rs:17`, `issue_844_terrain_and_alignment.rs:26`, `issue_845_wall_elemented_case.rs:31`, `issue_853_slab_pocket.rs:29`, `issue_584_smiley_west_test.rs:33`, `mesh_welding_calibration.rs:36`, `issue_960_segmented_roof_clip.rs:51`, `issue_1348_swept_disk_composite_arc.rs:25`, `issue_819_triangulated_normals.rs:47`, `issue_842_bspline_and_sphere.rs:20`, `issue_1910_storey_generalization.rs:33`, `issue_859_railway_renders_in_view.rs:40`, `issue_828_sectioned_solid_horizontal.rs:35`, `issue_820_trimmed_curve_planeangleunit.rs:53`, `issue_604_door_regression.rs:55`, `issue_582_583_regression_test.rs:26`, `issue_1485_duct_elbow_surface_curve_swept.rs:28`, `cdt_volume_watertight_verify.rs:47`, `issue_832_opening_representations.rs:61`, `issue_854_rect_hollow_fillet.rs:31`, `issue_859_linear_placement.rs:34`, `issue_821_difference_emptied_host.rs:58`, `issue_1007_roof_brep_opening_winding.rs:47`, and `rust/geometry/src/processors/tests.rs:16`.
  - Related helpers: `lfs_pointer_prefix` x5 (`issue_821:54`, `issue_953:52`, `issue_819:43`, `issue_828:31`, `issue_820:49`); `fixture_present` x5 (`wall_opening_cut_regression.rs:120`, `polygonal_bounded_half_space_side_regression.rs:38`, `door_window_calibration_regression.rs:48`, `issue_3435_classify_probe.rs:78`, `issue_068_void_ordering_probe.rs:45`); `fixture_path` x4; `crate_dir` x5; `repo_root` x4; `fixture` x15.
  - Inline `let Ok(c) = read_to_string(..) else { return }` skips without the gate: `tests/issue_604_advanced_face_holes.rs:26`, `tests/streaming_rtc_late_site.rs:49`, `tests/ar_wall_test.rs:154`, `tests/test_infra_rtc.rs:49,84`, `tests/mapped_item_shared_cache.rs:114-119`, `tests/rect_param_census.rs:92`, `rust/geometry/src/alignment_sampling_tests.rs:125,170`.
- What: there are three behaviour families:
  1. **Return `String` and panic** (6 files). These are relative-path or `CARGO_MANIFEST_DIR` based, with no LFS check.
  2. **`Option` + `require_fixtures`, no LFS-pointer check** (about 7 files). An LFS pointer is parsed as STEP and fails confusingly.
  3. **`Option` + LFS check + `require_fixtures`.**

  `src/processors/tests.rs:16` handles LFS but ignores the gate. `tests/support/mod.rs` contains only `require_fixtures()`. Its own doc admits it duplicates `rust/export/src/test_support.rs` and `rust/processing/tests/issue_3821_boolean_failure_drain.rs`.
- Why it matters: this is the #2802 failure mode ("a passing skip-shaped test is indistinguishable from one that asserted"). The CI job that sets `IFC_LITE_REQUIRE_FIXTURES=1` still gets silent skips from every file outside family 3. Each copy also has to be fixed separately when the fixture convention changes again.
- Fix: grow `tests/support/mod.rs` into the single fixture API:
  - `fixture(rel) -> Option<String>`, which handles NotFound, LFS pointer, the gate, and other I/O errors (panic);
  - `require_or_skip!` macro;
  - `repo_root()` / `crate_dir()`.

  Mirror it for in-crate tests as `crate::test_support::fixture` (already compiled under `cfg(test)`). Add a CI grep that bans `read_to_string(.*tests/models` outside the support module.
- Effort: M

### GEOM-5: Test mesh oracles (volume, open edges, watertight, bbox) duplicated 80+ times with different keying/tolerances
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - **`mesh_volume`** (17): `rust/geometry/src/world_frame_fixture.rs:125`; `tests/` `issue_3353_near_coplanar_rotated_overlap.rs:153`, `issue_098_v5c.rs:47`, `engulfing_solid_void.rs:75`, `wall_opening_cut_regression.rs:41`, `csg_property_test.rs:95`, `rect_param_gate.rs:102`, `rect_param_validate.rs:96`, `rect_param_production.rs:79`, `rect_param_parity.rs:28`, `opening_void_cut_local_frame_test.rs:94`, `issue_1167_real_wall.rs:311`, `issue_068_void_ordering_probe.rs:131`, `issue_1167_rotated_wall_opening.rs:28`, `issue_098_reveal_wall.rs:62`; `src/processors/boolean/chain_cycle_tests.rs:330`, `src/kernel/mesh_bridge_tests.rs:11`, `src/router/voids/prism_cut_tests.rs:98`.
  - **`signed_volume`** (10): `src/processors/boolean/halfspace_cap_tests.rs:62`, `tests/bath_csg_solid_test.rs:49`, `tests/ifc4x3_sectioned_linear_positions.rs:157`, `tests/halfspace_clip_cap_regression.rs:91`, `tests/issue_1007_roof_brep_opening_winding.rs:92`, `tests/issue_1007_opening_sliver.rs:53`, `tests/cdt_volume_watertight_verify.rs:86`, `src/extrusion_watertight_tests.rs:128`, `src/facet_weld_scoped_tests.rs:52`, `src/router/voids/flap_clip_tests.rs:73`.
  - **`volume`** (8 test-side).
  - **open-edge counters:**
    - `open_edges` x17: `src/test_support.rs:20`, `tests/issue_098_atomic_cut.rs:49`, `tests/issue_3435_classify_probe.rs:118`, `tests/issue_3353_near_coplanar_rotated_overlap.rs:119`, `tests/issue_098_v5c.rs:26`, `tests/issue_3353_sweep_261_classification_tear.rs:160`, `tests/touching_operand.rs:65`, `tests/issue_3353_boolean_tear.rs:123`, `tests/issue_3353_unrecovered_crosstab.rs:185`, `tests/issue_5313_thin_drop_tjunction.rs:44`, `tests/issue_5362_fallback_disjoint_opening.rs:69`, `tests/issue_098_reveal_wall.rs:25`, `tests/issue_1167_real_wall.rs:332`, `src/rect_fast.rs:520`, `src/processors/boolean/halfspace_cap_tests.rs:33`, `src/kernel/mesh_bridge_tests.rs:623`, `src/kernel/issue_3913_sweep_tests.rs:157`;
    - `open_boundary_edges` x4: `tests/csg_quality_regression.rs:147`, `tests/triangulation_invariance.rs:360`, `tests/halfspace_clip_cap_regression.rs:66`, `tests/issue_1007_real_opening_no_bridge.rs:166`;
    - `watertight` x7: `tests/rect_param_{production:95,validate:114,gate:123,parity:60}.rs`, `tests/rect_fast_placement_frame_spike.rs:89`, `src/router/voids/prism_cut_tests.rs:102`, `src/router/voids/coaxial_union_tests.rs:91`.
  - **`mesh_bbox`** x5: `tests/issue_953:87`, `issue_828:285`, `issue_604_door_regression:308`, `issue_820:88`, `issue_1172:70`.
  - **`bounds`** x9 and **`bbox`** x7.
  - **`worst_aspect`** x3: `issue_1007_*`.
  - **`mesh_from_tris`** x3: `src/mesh_tests.rs:8`, `src/facet_weld_scoped_tests.rs:277`, `src/router/voids/prism_cut_tests.rs:526`.
  - **Production homes that already exist:** `kernel::mesh_volume::mesh_volume` (`src/kernel/mesh_volume.rs:74`, `pub`, translation-stable), used by only 5 test files. Production open-edge counters are listed in GEOM-17.
- What: the oracles disagree:
  - Open edges are keyed by exact f32 bits (`test_support.rs:20`), a 1e4 grid (`issue_098_v5c.rs:31`), a 1e-6 `welded_by_position` (`touching_operand.rs:71`), and other grids. Some return `i64`, some `Result`, some count `!= 2`, some count `== 1`.
  - Most volume helpers sum tetrahedra about the world origin. `kernel/mesh_volume.rs:60-73` documents this as translation-variant for open meshes and far-from-origin operands. `world_frame_fixture::mesh_volume` does exactly that and is fed the 10 km `FarBaked` case.
- Why it matters: the same regression can pass one test and fail another purely because of oracle keying. Origin-referenced volumes lose about 1e-4 m³ of precision at 10 km. A fix to the oracle has to be repeated about 80 times.
- Fix: add `ifc_lite_geometry::test_support::mesh_oracles` behind the existing `test-support` feature, enable it as a dev-dependency feature on self, and include it via `mod support` in integration tests. It should provide:
  - `volume(&Mesh)`, delegating to `kernel::mesh_volume`;
  - `open_edges(&Mesh, Key::{Bits, Grid(f64), Weld(f32)})`;
  - `bbox`, `worst_aspect`, `mesh_from_tris`.

  Delete the copies.
- Effort: M

### GEOM-6: Box/cube mesh builders duplicated 35+ times; `boxed(min,size,rot)` copied verbatim 7x
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `boxed(min,size,rot)` with identical bodies (md5 match): `src/kernel/arrangement/issue_3353_vid_census_tests.rs:309`, `tests/issue_3353_near_coplanar_rotated_overlap.rs:68`, `src/kernel/issue_3913_sweep_tests.rs:105`, `tests/issue_3353_unrecovered_crosstab.rs:135`.
  - Near-identical copies: `tests/issue_3353_sweep_261_classification_tear.rs:119`, `src/kernel/mesh_bridge_tests.rs:585`, `src/kernel/nary_union_tests.rs:15`.
  - Other box builders:
    - `tests/touching_operand.rs:31`, `tests/issue_3353_boolean_tear.rs:78,108`;
    - `tests/csg_property_test.rs:55`, `tests/issue_1109_budget.rs:24`, `tests/snap_grid_unit_denomination.rs:148`, `tests/issue_977_flush_recess.rs:31`, `tests/rect_fast_placement_frame_spike.rs:28`, `tests/clash_intersection_oracle.rs:29,73`, `tests/bool_failure_test.rs:17`, `tests/triangulation_invariance.rs:1565`, `tests/csg_clip_epsilon_scale_regression.rs:110`, `tests/issue_960_segmented_roof_clip.rs:385`;
    - `src/mesh_orient_tests.rs:13,18`, `src/mesh_tests.rs:202`, `src/world_frame_fixture.rs:45`, `src/geom_hash_tests.rs:13`, `src/clash_contact_axes_tests.rs:15`, `src/projection_outline_tests.rs:11`, `src/rect_fast.rs:485`;
    - `src/csg/consolidate.rs:835`, `src/csg/csg_tests.rs:475,651,888`, `src/processors/boolean/halfspace_cap_tests.rs:10`, `src/processors/boolean/polygonal_removal_tests.rs:59`, `src/simplify/mod.rs:131`, `src/router/voids/flap_clip_tests.rs:12,91,206`, `src/router/voids/coaxial_union_tests.rs:16`, `src/router/voids/sweep_tests.rs:35`, `src/router/voids/bool2d_transaction_tests.rs:63`, `src/router/voids/prism_cut_tests.rs:13`, `src/router/transforms/mesh_world_tests.rs:15`.
  - Production: `src/kernel/arrangement/boolean.rs:281,295` (`box_mesh` / `cube_mesh` on `Tri`), `src/processors/csg_primitive.rs:276`, `src/simplify/boxify.rs:28`, `src/router/voids/synthesis.rs:654`.
- What: each copy picks its own face table, normal computation, f32 vs f64 corners, and per-face vs shared vertices. The `[0,3,2,1],[4,5,6,7],...` face table appears more than 10 times.
- Why it matters: this is the single largest copy-paste block in the test tree. Winding mistakes in one copy silently invert a test's premise.
- Fix: one `test_support::meshes::{box_mesh(lo, hi), box_mesh_rotated(lo, size, Option<(axis, angle, about)>), unit_cube()}` built on `kernel::arrangement::box_mesh` + `tris_to_mesh`, shared by in-crate and integration tests.
- Effort: S

### GEOM-7: `build_void_index` (23 copies) and router-setup boilerplate duplicated across fixture integration tests
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `build_void_index`: `tests/ar_wall_test.rs:50`, `issue_960_segmented_roof_clip.rs:80`, `issue_1007_roof_brep_opening_winding.rs:75`, `clash_intersection_real_model.rs:56`, `issue_098_v5c.rs:64`, `rect_param_census.rs:26`, `engulfing_solid_void.rs:97`, `dedup_validate.rs:292`, `rect_param_validate.rs:51`, `issue_1007_real_opening_no_bridge.rs:58`, `issue_853_slab_pocket.rs:62`, `cdt_volume_watertight_verify.rs:23`, `rect_param_production.rs:119`, `rect_param_gate.rs:85`, `opening_void_cut_local_frame_test.rs:115`, `csg_model_profile.rs:33`, `issue_1167_real_wall.rs:353`, `issue_098_reveal_wall.rs:79`, `issue_1367_multibody_opening.rs:101`, `geometry_correctness_harness.rs:268`, `rect_param_parity.rs:149`, `issue_3977_vertical_wall_frame.rs:81`, `wall_opening_cut_regression.rs:88`.
  - `build_void_index_like_production` x3: `voids_common/production.rs:63`, `issue_964_arbitrary_profile_voids.rs:44`, `issue_635_boolean_clipping_test.rs:68`.
  - `process_element_only` x3.
  - jscpd's largest geometry clones:
    - `issue_3440_manifold_gate_census.rs:27-90` vs `issue_3440_topology_gate_census.rs:25-88` (64 lines);
    - `issue_068_void_ordering_probe.rs:26-82` vs `issue_3435_classify_probe.rs:60-115` (57 lines);
    - `issue_582_583_regression_test.rs:75-123` vs `issue_584_smiley_west_test.rs:76-124` (49 lines);
    - `issue_098_reveal_wall.rs:60-108` vs `issue_098_v5c.rs:45-93` (49 lines);
    - `issue_4067_diagnostic_cache_repro.rs:53-90` vs `issue_4083_diagnostic_dedup_test.rs:37-74` (38 lines);
    - `material_layers_test.rs:22-48` vs `voids_common/fixtures.rs:8-34` and `:254-280`.
- What: production builds the void index via `ifc_lite_geometry::build_aggregate_children_index` / `VoidIndex` plus processing's orchestrator. Every test re-derives it from a scanner loop, and `voids_common/production.rs` exists exactly to share this, but only 6 files `mod voids_common`. `tests/census_golden/mod.rs` is shared by 3 binaries, yet those same 3 still duplicate `crate_dir` / `repo_root` / `fixture_present`.
- Why it matters: when production void indexing changes (e.g. aggregate propagation), 23 test copies keep the old semantics and keep passing.
- Fix: move `build_void_index_like_production`, `process_host_like_production` and the 3440 census harness into `tests/support/`. Better, expose a `#[cfg(feature="test-support")] pub fn void_index_for_content(&str)` from the crate that calls the real `VoidIndex` builder.
- Effort: M

### GEOM-8: 128 integration-test binaries; probes/census/spikes compiled as tests
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/geometry/tests/*.rs` (128 top-level files, 39k lines). Dev tools compiled as test binaries:
  - `csg_model_profile.rs`, `dedup_validate.rs` (911 lines), `issue_068_void_ordering_probe.rs`, `issue_3435_classify_probe.rs` (594);
  - `issue_3440_*_census.rs`, `rect_param_{census,gate,parity,production,validate}.rs`;
  - `multi_body_void_spike.rs`, `rect_fast_placement_frame_spike.rs`, `mesh_welding_calibration.rs`.

  God test files: `tests/census_golden/mod.rs` (2934 lines), `tests/triangulation_invariance.rs` (2437), `src/instancing/tests.rs` (2113), `src/space_dcel/tests.rs` (1525), `tests/clash_intersection_oracle.rs` (1018).
- What: each `tests/*.rs` file links its own binary against geometry and all of its dependencies (nalgebra, i_overlay, bnum, num-rational, rayon). Most probe/census files are `#[ignore]` measurement tools, and `multi_body_void_spike.rs`, `rect_fast_placement_frame_spike.rs` and `issue_3440_topology_gate_census.rs` have no `#[ignore]` at all. `issue_NNNN_*.rs` naming groups tests by ticket rather than by subsystem, which is why helpers cannot be shared without `mod support;` boilerplate in each file.
- Why it matters: link time dominates `cargo test -p ifc-lite-geometry`, and finding the regression tests for (say) swept disks means grepping issue numbers.
- Fix: consolidate into a few binaries by subsystem (`tests/regressions/main.rs` with `mod voids; mod swept; mod brep; ...` and a shared `mod support`). Move measurement tools to `examples/` or a `tools/` bin. Split god test files by concern.
- Effort: L

### GEOM-9: lib.rs root re-exports: 60 items have no user outside the crate, ~20 more only geometry's own tests
- Category: Best-practice
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/geometry/src/lib.rs:200-291`.
- What: zero references anywhere in `rust/` or `apps/` outside `rust/geometry`:
  - processors: `AdvancedBrepProcessor`, `ExtrudedAreaSolidProcessor`, `ExtrudedAreaSolidTaperedProcessor`, `FaceBasedSurfaceModelProcessor`, `FacetedBrepProcessor`, `SurfaceOfLinearExtrusionProcessor`, `SweptDiskSolidProcessor`, `MeshTexture`;
  - alignment and analytic: `AlignmentFrame`, `AlignmentSample`, `AlignmentSamplingReport`, `AnalyticProfile`, `AnalyticProfileLoop`;
  - diagnostics: `ClassificationSummary`, `OpeningDiagnostic`, `WorstHost`, `UNATTRIBUTED_PRODUCT_ID`, `SkippedProfile`;
  - instancing: `DecodedInstance`, `DecodedInstanced`, `DecodedTemplate`, `INSTANCED_MAGIC`, `INSTANCED_VERSION`, `collate_instances`, `collate_refs_verified_in`, `encode_instanced`, `verify_recomposition`;
  - scan outline: `MAX_CELLS_LIMIT`, `MAX_GAP_LIMIT`, `MAX_SNAP_DISTANCE_CELLS`, `MAX_VERTEX_MOVE_CELLS`, `MIN_CELL_SIZE_LIMIT`, `ScanOutlineDiagnostics`;
  - profiles and 2D: `LayerInfo`, `Profile2DWithVoids`, `VoidInfo`, `Vector2`, `boolean_2d_fixed_grid`, `ensure_ccw`, `ensure_cw`, `is_valid_contour`, `point_in_contour`, `subtract_multiple_2d`, `subtract_multiple_2d_counted`, `extract_analytic_profile`, `extrude_profile_lofted`, `extrude_profile_with_voids`;
  - placement parsing: `parse_axis2_placement_3d_from_id`, `parse_cartesian_point`, `parse_cartesian_point_from_id`, `parse_direction`, `parse_direction_from_id`;
  - stats drains: `take_bool2d_stats`, `take_cdt_recovery_fallbacks`, `take_prism_defers`;
  - other: `SimplifyStats`, `TerrainCdtMesh`, `triangulate_terrain_pslg`, `hash_mesh_world`, `build_aggregate_children_index`, `scale_segments`.

  `decode_instanced` / `decode_instance_finishes` are used only by tests: the Rust decoder is the "spec the TS decoder mirrors". Also, the comment at `lib.rs:71-76` says "only 8 modules ... must stay pub", but 16 are `pub`:
  - `analytic`, `clash_solid`, `csg`, `csg_capture`, `kernel`, `material_layer_index`, `mesh`, `mesh_weld`;
  - `opening_perf_trace`, `progress`, `projection_outline`, `rect_fast`, `simplify`, `space_dcel`, `test_support`, `zone_split`.

  `pub use triangulation::alt_oracle::set_alt_triangulator` sits in the middle of the `mod` list (`:153`), and the re-export blocks are neither rustfmt-ed nor sorted.
- Why it matters: every `pub` item is semver surface for a published crate (`description` / `keywords` are set), it blocks refactors such as GEOM-2, and it advertises internal stats drains as API.
- Fix:
  - Gate test-only items (`decode_*`, `verify_recomposition`, `Decoded*`) behind `test-support`.
  - Make the internal processor types, scan_outline limit constants and `take_*` drains `pub(crate)`, or move the drains into a `pub mod diagnostics_probe` with `#[doc(hidden)]`.
  - Update the module comment.
  - Treat it as a breaking change and bump the version.
- Effort: S

### GEOM-10: Crate-level rustdoc and example are stale (non-existent APIs, wrong claims)
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/geometry/src/lib.rs:5-69`; `rust/geometry/examples/color_extraction_test.rs`; `rust/geometry/Cargo.toml` `[[example]]`.
- What:
  - The Quick Start uses `Profile2D::rectangle(2.0, 1.0)`, which does not exist (there is a free fn `profile::create_rectangle`, and it is not re-exported).
  - It calls `extrude_profile(&profile, direction, 3.0)`, but the real signature is `(profile, depth, Option<Matrix4>)`.
  - It calls `router.process(&decoder, &entity)`, but the real methods are `process_element*`.
  - The examples are `rust,ignore`, so nothing catches this.
  - "Triangulation via earcutr" is stale: CDT is primary. The "Performance" numbers are undated.
  - `examples/color_extraction_test.rs` (594 lines) does not use `ifc_lite_geometry` at all. It re-implements style and colour resolution (`build_geometry_style_index`, `extract_color_from_rendering`, ...) that lives in `ifc_lite_processing::style`. It hard-codes `/home/user/ifc-lite/...` and a wrong relative path `../../../tests/models`, and its header describes a bug ("colors are not extracted ... MappedRepresentation") that has since been fixed.
- Why it matters: it misleads crate users, and the example is a fourth colour-resolution implementation that drifts silently.
- Fix: replace the rustdoc examples with compiled (non-`ignore`) doctests against current APIs. Delete the example, or move it to processing and rewrite it on `processing::style`.
- Effort: S

### GEOM-11: Inverse-transpose normal transform implemented 3x with different degenerate handling
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/instancing/dont_bake.rs:78-96`;
  - `rust/geometry/src/router/transforms/mesh_world.rs:354-368`;
  - `rust/geometry/src/scalar.rs:182-192` (that comment says "verbatim from the pre-refactor `apply_transform`", i.e. `extrusion.rs:425`).
- What: `mesh_world` and `scalar` use `transform.try_inverse().unwrap_or(*transform).transpose()`. On a singular transform that falls back to `M^T` (a wrong direction for non-orthogonal M), then `.normalize()`, which gives NaN for a zero result. `dont_bake` uses the 3x3 linear block with `.unwrap_or(linear)` (not transposed) and `try_normalize(0.0).unwrap_or(nv)`, which gives a zero normal rather than NaN. `dont_bake`'s doc claims its output is "Geometrically equal to the baked flat occurrence".
- Why it matters: for a degenerate mapped-item transform (zero-scale `IfcCartesianTransformationOperator`), the flat bake emits NaN normals while the don't-bake recovery emits zero normals, so the same element shades differently depending on which path materialised it.
- Fix: add one `transform::normal_matrix(&Matrix4) -> Matrix3` plus `transform_normals_in_place(&mut [f32], &Matrix3)`, with a documented singular policy. Have all three call it.
- Effort: S

### GEOM-12: SpacePlate (space_dcel) public/wasm edit API accepts NaN; non-total sort comparators can panic
- Category: Bug
- Severity: Medium
- Confidence: LIKELY
- Where:
  - sort comparators: `rust/geometry/src/space_dcel/arrangement.rs:166`, `rust/geometry/src/space_dcel/geom2d.rs:62,77`;
  - the edit API: `rust/geometry/src/space_dcel/mod.rs:243` (`build`), `:270`, `:438` (`drag_vertex`), `:562` (`split_edge`), `:766-786` (`add_face`);
  - wasm entry points: `rust/wasm-bindings/src/api/space_plate.rs:84-108`, `:218`, `:241`, `:269`.
- What: no entry point checks `is_finite` (only `net_outline` / `try_gap_boundary` at `mod.rs:1008,1112` do). A NaN coordinate from JS (`Float64Array`) flows into:
  - `cuts.sort_by(|p,q| p.0.partial_cmp(&q.0).unwrap_or(Equal))`, which is not a total order with NaN. Rust >= 1.81's sort "may panic if the comparison does not implement a total order", and the wasm build is `panic=abort`.
  - `add_face`, where `signed.abs() < EPS` and `(a-b).abs() < EPS` are both false for NaN, so a NaN room is persisted and corrupts later edits.
  - `drag_vertex`, which writes NaN into a shared vertex.

  `space_dcel/mod.rs:364` already uses `total_cmp` with a comment explaining why; the three sites above were missed.
- Why it matters: a single bad coordinate from the UI (division by zero upstream) can abort the geometry worker or poison the persisted floor plate.
- Fix:
  - Validate finiteness at `SpacePlate::build`, `build_from_wall_rects`, `drag_vertex`, `split_edge` and `add_face`; return `EditError::InvalidPolygon` or a new `NonFinite` error.
  - Switch the three sorts to `total_cmp`.
  - Workspace-wide there are 11 `partial_cmp(..).unwrap_or(..)` sorts against 70 `total_cmp` uses; pick one idiom (lint via `clippy::disallowed_methods`, or by review).
- Effort: S

### GEOM-13: Point-in-polygon (ray cast) implemented 8 times
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - canonical `rust/geometry/src/geom2d.rs:52` (`point_in_polygon`, `[f64;2]`);
  - `rust/geometry/src/space_dcel/geom2d.rs:14` (`point_in_quad`, a literal copy specialised to 4 points);
  - `rust/geometry/src/bool2d.rs:241` (`point_in_contour`, `Point2`);
  - `rust/geometry/src/triangulation/ring_geom.rs:23` (`point_in_ring`, flat `[f64]`);
  - `rust/geometry/src/processors/boolean/halfspace_cap.rs:245` (closure);
  - `rust/geometry/src/router/voids/prism_cut.rs:282`;
  - `rust/landxml/src/terrain_topology.rs:271`;
  - `rust/landxml/src/plan/numeric/topology.rs:139`.
- What: the same even-odd crossing test is written for four point representations. `ring_geom::point_in_ring` computes `n - 1` with `n = ring.len()/2`, which underflows if called on an empty ring (callers guarantee 3+ vertices today).
- Why it matters: boundary semantics (on-edge = outside) and NaN behaviour must stay identical across hole classification, cap triangulation and room detection.
- Fix: one generic `geom2d::point_in_ring<P: Into<[f64;2]> + Copy>(p, ring: impl ExactSizeIterator)`, or `[f64;2]` with zero-copy adapters (`bytemuck`-style casts for `Point2<f64>`). Delete `point_in_quad` and use `point_in_polygon(p, &quad)`.
- Effort: S

### GEOM-14: Signed shoelace area / centroid / ring bbox / 2D distance re-implemented beside `geom2d`
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - **Signed area:**
    - `rust/geometry/src/geom2d.rs:38` (canonical), `rust/geometry/src/bool2d.rs:201` (`compute_signed_area`, pub);
    - `rust/geometry/src/space_dcel/mod.rs:1198` (`signed_area_of_cycle`), `rust/geometry/src/space_dcel/geom2d.rs:48-55` (inline shoelace-centroid);
    - `rust/geometry/src/scan_outline/trace.rs:173` (`lattice_area2`, integer: justified);
    - `rust/geometry/src/router/voids/prism_cut.rs:801`, `rust/geometry/src/processors/advanced_face/bounds.rs:85`;
    - `rust/export/src/dfjson/plates.rs:128`, `rust/processing/src/pdf_vector/strokes.rs:165`;
    - tests: `src/triangulation_tests.rs:32`, `src/contour_bool2d_tests.rs:22`, `src/profiles/tests.rs:514`, `src/profiles/simplify_tests.rs:54`, `src/router/structural_tests.rs:88`.
  - **Ring bbox:** `rust/geometry/src/triangulation/ring_geom.rs:10`, `rust/geometry/src/scan_outline/topology.rs:345`, `rust/geometry/src/contour_bool2d.rs:95`, `src/space_dcel/tests.rs:1026`, `src/projection_outline_tests.rs:40`.
  - **2D distance:**
    - `rust/geometry/src/scan_outline/fit.rs:209` (`dist`), `rust/geometry/src/scan_outline/snap.rs:285` (`dist`), `rust/geometry/src/scan_outline/simplify.rs:178` (`dist2`);
    - `rust/geometry/src/scan_outline/topology.rs:358,363` (`sub` / `dot`);
    - `rust/geometry/src/contour_grid_guard.rs:15` (point-segment distance) vs `geom2d::perp_distance` (`geom2d.rs:72`).
  - **Convexity tests:** `rust/geometry/src/triangulation.rs:195` (`is_convex`, 2D, absolute 1e-10) and `rust/geometry/src/processors/brep/faceted.rs:150-170` (3D re-implementation).
- What: `geom2d.rs` was created explicitly so these "moved here verbatim instead of being copied a third time" (its doc, `geom2d.rs:8-12`). Despite that, scan_outline, the second geom2d file in `space_dcel/`, and bool2d still keep private copies.
- Why it matters: drift in degenerate handling (`< 3` points returns 0 in some copies and not in others), and every new 2D module grows its own `dist`.
- Fix: extend `geom2d` with `sub`, `dot`, `cross`, `dist`, `dist2`, `ring_bbox`, `centroid` and `is_convex`. Make `bool2d::compute_signed_area` a thin wrapper, or delete it (it has no external users, see GEOM-9).
- Effort: S

### GEOM-15: `[f64;3]` vector helpers (dot/cross/normalize/face_normal/canonical) copied across geometry, clash, export, processing
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - geometry:
    - `rust/geometry/src/clash_contact_axes.rs:37` (`canonical`), `:52` (`dot3`), `:56` (`cross3`), `:81` (`normalize3`), `:123` (`face_normal`);
    - `rust/geometry/src/kernel/arrangement/classify.rs:17,20`, `rust/geometry/src/facet_weld.rs:123` (`tri_normal`);
    - `rust/geometry/src/mesh_tjunction.rs:35,40-50` (`dist`, inline cross in `height`), `rust/geometry/src/world_frame_fixture.rs:77-85` (inline cross);
    - `rust/geometry/tests/issue_1007_real_opening_no_bridge.rs:34-43`;
  - clash: `rust/clash/src/obb_detect.rs:15-40` (`normalize`, `canonical`; jscpd clone of `clash_contact_axes.rs:37-50`);
  - export: `rust/export/src/geom.rs:231`, `rust/export/src/openings.rs:18-19`, `rust/export/src/adjacency.rs:24`;
  - processing: `rust/processing/src/appearance/mapping.rs:31`, `rust/processing/src/appearance/authored.rs:18-21`, `rust/processing/src/appearance/calibration.rs:36-39`;
  - processing tests: `rust/processing/tests/scan_synthetic/mod.rs:205-211`, `rust/processing/tests/scan_segmentation_{planes,cylinders}.rs`, `rust/processing/src/scan_proposals/proposals_tests.rs:18`.
- What: `canonical()` carries the comment "Same rule as the sibling OBB kernel's canonical", an acknowledged copy across crates. geometry cannot depend on clash, which has zero deps by design.
- Why it matters: the tie-break rules in `canonical` must match TS and clash bit for bit, and three copies are three places to break it.
- Fix: put a tiny dependency-free `vec3` module in `ifc-lite-core` (or share it by `#[path]`, as `world_frame_corpus.rs` already is) holding `dot`, `cross`, `sub`, `norm`, `normalize`, `canonical` and `tri_normal_relative`. Make the geometry, clash, export and processing copies import it.
- Effort: S

### GEOM-16: Inline union-find implementations beside `union_find::UnionFind`
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: canonical `rust/geometry/src/union_find.rs:13`. Copies:
  - `rust/geometry/src/clash_solid_geom.rs:79-90` (nested `find` / `union`, reparents in the opposite direction);
  - `rust/geometry/src/router/voids/coaxial_union.rs:205`;
  - `rust/geometry/src/router/voids/geom.rs:129-138`;
  - `rust/geometry/src/router/voids/sweep.rs:121`.
- What: the four copies are path-halving clones with different index widths (`usize` / `u32`).
- Why it matters: determinism of roots is documented for `UnionFind` only; the copies each carry their own subtle ordering.
- Fix: use `crate::UnionFind`. Add `with_capacity`, and a `usize` variant if needed.
- Effort: S

### GEOM-17: Production open-edge / closedness checks: 7 variants with different vertex keys
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/csg/consolidate.rs:81` (`count_open_boundary_edges`, quantised) and `:527` (`_exact`, bits);
  - `rust/geometry/src/csg/consolidate/conform/open_edges.rs:15` (`_at(scale)`);
  - `rust/geometry/src/router/voids/geom.rs:394` (`param_cut_watertight`, 1e-4 grid at `:405`);
  - `rust/geometry/src/router/voids/prism_cut/closure_checks.rs:338` (`edge_multiplicity_defects`);
  - `mesh_is_closed_exact` in `router/voids/geom.rs` (`pub(super)`; `kernel/mesh_volume.rs:62-69` complains that it is unreachable);
  - `rust/geometry/src/mesh_orient.rs:146` (`is_single_closed_solid`);
  - `rust/geometry/src/test_support.rs:20`.
- What: each builds its own `HashMap<(key, key), count>` with a different key: f32 bits, f64 bits, `round(v*1e4)`, `round(v/scale)`, or welded index. `kernel/mesh_volume.rs` explicitly notes that callers needing a closedness gate must "widen visibility or write an equivalent check of its own", which invites an eighth copy.
- Why it matters: "watertight" means different things in different gates. The census gates (`csg_topology_gate`, `csg_manifold_gate`) and the tests (GEOM-5) cannot be compared like for like.
- Fix: add a `mesh_topology` module (`pub(crate)`, also exported under `test-support`) with `EdgeKey::{Bits, Grid(f64)}` and `edge_census(&Mesh, EdgeKey) -> {open, over_shared, same_direction}`. Implement the existing predicates as thin wrappers.
- Effort: M

### GEOM-18: "Scan to IFCPROJECT and read length/angle unit" implemented 6+ times; geometry has two verbatim copies
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - verbatim pair in geometry: `rust/geometry/src/router/mod.rs:297` (`scan_unit_scale`) and `rust/geometry/src/profile_extractor.rs:747` (`detect_unit_scale`);
  - cached canonical versions: `rust/core/src/decoder.rs:326` (`plane_angle_to_radians`) and `:357` (`length_unit_scale`);
  - other scanners: `rust/geometry/src/alignment_sampling.rs:198-209` (resolves twice via `ProjectUnits::resolve` AND `extract_length_unit_scale` and requires them to agree), `rust/wasm-bindings/src/api/alignment_lines.rs:82`, `rust/export/src/quantity_analysis.rs:264`, `rust/export/src/relationships.rs:59`.
- What: the two geometry copies are line-for-line identical to `EntityDecoder::length_unit_scale()` minus its cache. Each does a full `EntityScanner` pass over the file. `alignment_sampling::resolve_scale` cross-checking two core resolvers shows core itself has two length-unit resolvers (`project_units` and `units`).
- Why it matters:
  - Perf: redundant O(file) scans per router or extractor construction.
  - Correctness: if the resolvers ever differ (e.g. `ConversionBasedUnit` handling), geometry and alignment output disagree.
- Fix: delete `scan_unit_scale` / `detect_unit_scale` and call `decoder.length_unit_scale()`. Raise the core dual-resolver issue with the core reviewer.
- Effort: S

### GEOM-19: Three strict placement-chain validators across crates, drifted
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/alignment_sampling_placement.rs:11` (`validate_placement`);
  - `rust/processing/src/analytic_export/placement.rs:11` (`validate_placement_chain`, plus `:114`, `:126`);
  - `rust/processing/src/appearance/source.rs:99` (`validate_world_placement`);
  - `rust/export/src/step_map_transform_preflight.rs:277` (`placement`).
- What: all walk `ObjectPlacement → PlacementRelTo` with a visited set and `MAX_PLACEMENT_DEPTH`. They differ in:
  - **Depth check:** alignment checks `visited.len() > MAX` after insert; analytic_export checks `seen.len() > MAX` before insert. That is an off-by-one difference in the maximum accepted depth.
  - **Accepted placements:** alignment accepts only LocalPlacement + Axis2Placement3D. analytic_export also accepts GridPlacement (schema-aware). appearance accepts Axis2Placement2D but checks no coordinates.
  - **Validation depth:** only alignment checks coordinate finiteness and Axis/RefDirection parallelism.
  - **Collections and errors:** `HashSet` vs `BTreeSet`, `Result<_, String>` vs `geometry::Error`.
- Why it matters: "is this placement chain valid?" gets three answers. A file accepted by appearance authoring can be rejected by analytic export.
- Fix: one `placement::validate_chain(entity, decoder, Policy{allow_grid, allow_2d, check_coords}) -> Result<(), PlacementError>` in core (next to `MAX_PLACEMENT_DEPTH`) or in `geometry::transform`.
- Effort: M

### GEOM-20: 13 env-var kill switches with inconsistent truthiness semantics and no single home
- Category: Quirk
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/rect_fast.rs:67` (`IFC_LITE_RECT_FAST != "0"`) and `:94` (`IFC_LITE_RECT_PARAM`);
  - `rust/geometry/src/router/voids/coaxial_union.rs:91` (`IFC_LITE_VOID_UNION != "0"`);
  - `rust/geometry/src/router/voids/bool2d_path.rs:59` (`IFC_LITE_VOID_2D != "0"`);
  - `rust/geometry/src/router/voids/prism_cut.rs:90` (`IFC_LITE_PRISM_CUT != "0"`);
  - `rust/geometry/src/router/mod.rs:381` (`IFC_LITE_DEDUP_EXTRA == "1"`);
  - `rust/geometry/src/router/transforms/mod.rs:74` (`IFC_LITE_LOCAL_FRAME` `.is_ok()`, so ANY value including `0` enables it);
  - `rust/geometry/src/processors/boolean/halfspace_cap.rs:70` (`IFC_LITE_HALFSPACE_CAP_OFF` `var_os().is_some()`, so `=0` disables the cap; read on every call, uncached);
  - `rust/geometry/src/triangulation/alt_oracle.rs:34` (`IFCLITE_TRIANGULATION_ALT`: different prefix, presence-only);
  - `rust/geometry/src/processors/boolean/cut_heuristics.rs:60` (`IFC_LITE_FAST_CUT_RATIO`);
  - `rust/geometry/src/kernel/budget.rs:131,140` (`IFC_LITE_CSG_BUDGET`, `IFC_LITE_CSG_ELEMENT_BUDGET`).
- What: four truthiness conventions: `!= "0"`, `== "1"`, is-set, and is-set-means-off. They are all cached in ad-hoc `static ON: OnceLock<bool>` copies (5 copies), except halfspace_cap. They are documented nowhere central.
- Why it matters: `IFC_LITE_LOCAL_FRAME=0` turning the local frame ON is the kind of surprise that produces wrong-frame server output during debugging. The uncached `var_os` in halfspace_cap takes the process env lock once per clip.
- Fix: add one `flags.rs` holding `env_flag(name, default) -> bool` (strict parse: unset / "0" / "1", panic or warn on anything else, as `tests/support::require_fixtures` already does) and `env_f64` / `env_u64`, each a cached `OnceLock`. Use one `IFC_LITE_` prefix and list all flags in `rust/AGENTS.md`.
- Effort: S

### GEOM-21: ~10 independent global/thread-local telemetry mechanisms; 5 `take_*` drains exported from crate root
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `AtomicU64` statics: `rust/geometry/src/cdt.rs:68-78` (unconditional), `rust/geometry/src/router/voids/bool2d_path.rs:62-72` (unconditional), `rust/geometry/src/router/voids/prism_cut.rs:107-206` (feature-gated), `rust/geometry/src/kernel/budget.rs:100-112`;
  - `rust/geometry/src/kernel/plane_weld.rs:63,82` (cfg twin);
  - `rust/geometry/src/csg/mod.rs:173` (`take_csg_census`), `rust/geometry/src/rect_fast/param_stats.rs:14`;
  - thread-locals: `rust/geometry/src/diagnostics.rs:37` (dead, see GEOM-24), `rust/geometry/src/opening_perf_trace.rs:126`, `rust/geometry/src/telemetry_transaction.rs:16`;
  - `rust/geometry/src/csg_capture.rs:37,45` (`Mutex` + `AtomicBool`), `rust/geometry/src/progress.rs:28` (`OnceLock<fn()>`);
  - root re-exports: `rust/geometry/src/lib.rs:256,261-263`.
- What: `prism_cut.rs:92-98` states the convention: "telemetry is compiled in ONLY under an observability feature ... the default build carries no process-global atomics on the hot path". `bool2d_path.rs` and `cdt.rs` violate it. The telemetry mechanisms differ along every axis:
  - drain API: a tuple, `Vec<(&str, u64)>`, an array, or a struct;
  - whether the counter is gated behind a feature;
  - visibility;
  - whether it is speculative-aware (only some route through `telemetry_transaction::record`).
- Why it matters: every new counter invents its own pattern. Process-global atomics bleed across concurrent tests and across rayon workers in the server.
- Fix: put a single `telemetry` module in charge of all counters:
  - typed counters declared through one `counter!` macro that compiles to nothing without `observability`;
  - one `take_snapshot() -> TelemetrySnapshot` drain;
  - `telemetry_transaction` as the only speculative buffer.

  Remove the five root `take_*` re-exports (GEOM-9).
- Effort: M

### GEOM-22: f32-ULP noise scale spelled 9 ways (2^-20 … 2^-23, inline literals)
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - 2^-22: `rust/geometry/src/kernel/near_band.rs:54` (`F32_ULP_SCALE`), `rust/geometry/src/csg/plane_eps.rs:96` (duplicate const, with a cross-reference comment), `rust/geometry/src/kernel/retriangulate_cleanup.rs:60` (inline `1.0 / 4_194_304.0`), `rust/clash/src/depth.rs:212`;
  - 2^-20: `rust/geometry/src/instancing/verify.rs:76` (`ULP_FACTOR = 9.5367431640625e-7`), `rust/geometry/src/csg/consolidate/plane_merge.rs:75,170` (`8*f32::EPSILON`);
  - 6×2^-23: `rust/geometry/src/rect_fast.rs:592` (`2f64.powi(-23) * 6.0`);
  - f32::EPSILON based: `rust/geometry/src/router/voids/frame_snap.rs:50`, `rust/processing/src/appearance/transfer_target.rs:37`;
  - `ulp32()`: `rust/clash/src/world_frame_corpus.rs:63`.
- What: `grid.rs` is documented as the "single-sourced" home for shared tolerances but holds only `NORMAL_QUANT`. Every module states the f32-ULP bound in its own words and multiplier.
- Why it matters: the world-frame defect class (#2598 / #2600 / #2529, see `world_frame_fixture.rs:7-16`) came from exactly this kind of per-site tolerance reasoning.
- Fix: add `grid::F32_HALF_ULP_REL = 2^-24`, `F32_ULP_REL = 2^-23` and `f32_noise(mag, ulps)` to `grid.rs`. Express every site as a named multiple and keep the rationale comments.
- Effort: S

### GEOM-23: zone_split re-implements `kernel::broadphase::tris_aabb` twice
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/geometry/src/zone_split.rs:324` (`tris_aabb`), `rust/geometry/src/zone_split.rs:139-151` (`ZoneBox::world_aabb`, the same loop over `self.to_tris()`), and the canonical `rust/geometry/src/kernel/broadphase.rs:116`.
- What: these are identical loops. The empty-sentinel differs (`±INFINITY` vs `EMPTY_AABB = ([MAX;3],[MIN;3])`).
- Why it matters: they are small but have already drifted on the empty case.
- Fix: call `crate::kernel::broadphase::tris_aabb`.
- Effort: S

### GEOM-24: Dead code kept "just in case": PENDING_MAPPED_BOOL_FAILURES, Error::EmptyMesh, create_circle/calculate_circle_segments
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/diagnostics.rs:25-45`;
  - `rust/geometry/src/error.rs:23` (`EmptyMesh`: zero constructors);
  - `rust/geometry/src/profile.rs:261,299` (`create_circle`, `calculate_circle_segments`: only test callers in `extrusion.rs:541-585` and `profile.rs` tests; the production circle path is `profiles/shapes.rs:80` `circle_profile_segments(36)`).
- What:
  - The thread-local's own doc says "nothing pushes into this today. Kept ... in case a future ... context needs" it, and warns that it is a footgun (records drain into whichever router drains next on that thread). It is still drained on every `take_csg_failures` (`router/diagnostics_recording.rs:228`).
  - `calculate_circle_segments`' doc claims to describe "the historical baseline" for opening circles, but production no longer uses it.
- Why it matters: dead escape hatches attract new callers that hit the documented footgun, and a stale segment-count rule misleads anyone tuning tessellation.
- Fix: delete the thread-local and its drain call, `EmptyMesh`, and `create_circle` / `calculate_circle_segments` (or mark the last two `#[cfg(test)]`).
- Effort: S

### GEOM-25: `safe_earcut`'s contract doc is attached to `ear_clip`; `safe_earcut` undocumented
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/geometry/src/triangulation.rs:21-58`.
- What: the 27-line "Guarded ear-clipping — the ONLY sanctioned way to call `earcutr`" doc runs straight into "Ear-clip one sanitised ring group..." and is attached to the private `fn ear_clip` (`:51`). `pub(crate) fn safe_earcut` (`:59`) has no doc. rustdoc renders the safe-earcut contract on the wrong function.
- Why it matters: anyone reading `safe_earcut` (the sanctioned entry point) sees no contract, and the remap-to-caller-indices guarantee looks like `ear_clip`'s.
- Fix: move lines 21-45 above `safe_earcut`. Also, `safe_earcut` (133 lines) mixes sanitisation, classification and emission; split it into `sanitize_rings`, `classify_holes` and `emit`.
- Effort: S

### GEOM-26: `geom_hash` / weld / tjunction / clash bit-keyed vertex maps treat -0.0 and +0.0 as distinct
- Category: Quirk
- Severity: Low
- Confidence: SUSPECT
- Where:
  - `rust/geometry/src/mesh_tjunction.rs:25-28` (`key_of`);
  - `rust/geometry/src/mesh_weld.rs:125-135` (`vkey`);
  - `rust/geometry/src/clash_solid.rs:257`, `rust/geometry/src/clash_solid_geom.rs:96`;
  - `rust/geometry/src/test_support.rs:20-31`.

  Contrast `rust/geometry/src/terrain_cdt.rs:70`, which explicitly canonicalises signed zero.
- What: `to_bits()` keys split `-0.0` from `+0.0`. In mesh_tjunction, an edge whose shared vertex is `-0.0` on one side and `+0.0` on the other counts as an open edge. Signed zeros arise from negations or mirrored transforms (e.g. `0.0 * -1.0`).
- Why it matters: it can cause a spurious T-junction repair or an unwelded duplicate. The likelihood is low, but the fix is free.
- Fix: one `grid::bit_key(f32) -> u32` helper that maps `-0.0` to `+0.0` (and optionally NaN to a single canonical value), used by every bit-keyed map.
- Effort: S

### GEOM-27: `bool2d` and `contour_bool2d` / `contour_composition` are parallel i_overlay wrappers with drifted sanitisation
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/bool2d.rs:38-170` (`is_valid_contour` at `:190`: area > 1e-10, no finiteness check);
  - `rust/geometry/src/contour_bool2d.rs:176-195` (`sanitize`: finite + closing-duplicate + collinear) and `:247-250` (`resolve`, self-union);
  - the same self-union at `rust/geometry/src/bool2d.rs:164-166`;
  - `rust/geometry/src/contour_composition.rs:88-127`;
  - `rust/geometry/src/projection_outline.rs:198`.
- What: these are four i_overlay call families, each with its own path conversion and degenerate filtering:
  - NaN rings are filtered in `contour_bool2d` but are passed straight to i_overlay by `bool2d` and `projection_outline`;
  - the self-union "resolve" idiom is written twice;
  - `contour_bool2d.rs:222-245` (`boolean_2d_fixed_grid`, `sanitize_fixed_grid`) is visibly not rustfmt-ed (`let count=...`) and returns `Result<_, String>`.
- Why it matters: profile-void subtraction and general contour booleans should agree on what a degenerate ring is.
- Fix: route `bool2d` through `contour_bool2d::sanitize` / `resolve`, keeping only the `Profile2D` ↔ `Ring2D` adapters in `bool2d`. Run rustfmt on the new fixed-grid block.
- Effort: S

### GEOM-28: `transform.rs` internal duplication: `parse_cartesian_point_from_id` re-implements `parse_decoded_cartesian_point`
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/geometry/src/transform.rs:159-181` vs `:186-219`; the four Z/X-axis blocks at `:33-60` and `:249-277`.
- What: `_from_id`'s fallback copies the type check plus the coordinate read verbatim instead of calling `parse_decoded_cartesian_point`. The axis-defaulting `if let ... else ... else` pyramid appears four times in this one file.
- Why it matters: this file is the declared "unified implementation, eliminating code duplication" (its module doc).
- Fix: `parse_cartesian_point_from_id` should be `get_cartesian_point_fast(id).map(Ok).unwrap_or_else(|| parse_decoded_cartesian_point(&decoder.decode_by_id(id)?))`. Add `opt_direction(attr, decoder, default)`.
- Effort: S

### GEOM-29: `curve_source::trim_point` and `trim_angle` duplicate the trim-select parse loop
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/geometry/src/curve_source.rs:156-186` vs `:227-262` (jscpd: 163-180 vs 235-252).
- What: the `IfcTrimmingSelect` list walk (entity ref → point, `IFCPARAMETERVALUE` typed list → param, bare float → param) is copied. Both then apply the same `cartesian` preference rule.
- Why it matters: a fix to trim parsing (e.g. typed-param variants) must be made twice.
- Fix: `fn parse_trim_select(values, decoder, tolerant) -> Result<(Option<f64>, Option<[f64;3]>)>`, used by both.
- Effort: S

### GEOM-30: IFNS header parsing duplicated between `decode_instanced` and `decode_instance_finishes`
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/geometry/src/instancing/wire_decode.rs:16-63` vs `:156-173`.
- What: the magic, version, stride derivation, alignment check and checked offset arithmetic are written twice, and so are the `ru32` / `rf32` closures. `decode_instance_finishes` documents that it must refuse exactly what `decode_instanced` refuses. Both decoders are test-only in Rust (see GEOM-9).
- Why it matters: a future v4 header change has to be mirrored in two Rust decoders plus TS.
- Fix: `fn parse_header(bytes) -> Option<Header{template_count, instance_count, stride, it_off, data_off,...}>` shared by both. Gate both behind `test-support` if they really are oracle-only.
- Effort: S

### GEOM-31: Geometry `[lints.clippy]` blanket allows broader than needed; redundant local allows
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/geometry/Cargo.toml` `[lints.clippy]`. Local allows that the crate-wide ones already make no-ops:
  - `rust/geometry/src/scan_outline/fit.rs:58`, `rust/geometry/src/material_layer_index.rs:268`, `rust/geometry/src/cdt.rs:671`, `rust/geometry/src/extrusion_byte_identity_tests.rs:25`;
  - 12 `#[allow(clippy::too_many_arguments|needless_range_loop|...)]` crate-wide.
- What: the numeric allows mirror the workspace and are justified (`rust/AGENTS.md`). Of the structure allows:
  - `too_many_arguments` has 12 offending fns crate-wide (worst: `profile_extractor.rs:234` with 11 args; `instancing/group.rs:326` `fall_back` with 9);
  - `should_implement_trait` has 4 (`kernel/interval.rs:58-66` `add` / `sub` / `mul`, which should simply impl `std::ops`; `mesh.rs:184`);
  - `needless_range_loop` and `type_complexity` are plausible for a numerics kernel;
  - `large_enum_variant` hides the size of hot enums (e.g. `OpeningType`) without a measurement.

  The geometry crate does not inherit `[workspace.lints]`, so any future workspace lint (e.g. `unsafe_code = "forbid"`) silently does not apply here.
- Why it matters: blanket allows remove the signal on new offenders.
- Fix:
  - Drop `should_implement_trait` and implement `Add` / `Sub` / `Mul` for the interval type.
  - Downgrade `too_many_arguments` to per-fn allows or param structs on the 12 sites.
  - Delete the redundant local allows.
  - Add a comment that new workspace lints must be copied here, or a CI check that diffs the two blocks.
- Effort: S

### GEOM-32: `diag_warn!` call sites gate the legacy fallback on `debug_assertions`, contradicting diag.rs policy
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/geometry/src/instancing/group.rs:99-108`, `rust/geometry/src/router/voids/mod.rs:1640-1650` and `:1682-1690`, `rust/geometry/src/processors/advanced.rs:136-142`. The policy is in `rust/geometry/src/diag.rs:17-21`.
- What: the policy says WARN sites "must NOT silently disappear from default builds", so `diag_warn!` keeps the `eprintln!`. These sites wrap that `eprintln!` in `#[cfg(any(debug_assertions, test))]` or `#[cfg(feature="debug_geometry")]`, so release default builds (the native server without `observability`) emit nothing. Separately, raw `eprintln!` still appears in production router code (`router/voids/mod.rs`, `router/textured.rs`, `router/mapped_item.rs`, `router/layers.rs`, `router/instancing.rs`, about 15 sites), against `rust/AGENTS.md` ("never raw eprintln in the kernel").
- Why it matters: a singular `baked_basis` (an instancing refusal) is silent in exactly the builds where it matters. The doc and the code disagree.
- Fix: route debug-only messages through `diag_debug!`, and keep `diag_warn!` legacy branches ungated. Add a grep check for `eprintln!` in non-test geometry src.
- Effort: S

### GEOM-33: `world_frame_fixture` shares a source file with `rust/clash` via `#[path = "../../clash/src/..."]`
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/geometry/src/world_frame_fixture.rs:37`; `rust/clash/src/world_frame_corpus.rs`.
- What: a cross-crate `#[path]` include. The comment says the trade-off is recorded in the file header. It works, but the file is compiled into two crates with different lint sets, and `cargo package` for geometry would not include it.
- Why it matters: this breaks `cargo publish` / `cargo package` for `ifc-lite-geometry` if it is ever published from the workspace (`readme`, `keywords` and `description` suggest it is). It is a hidden coupling.
- Fix: move the corpus into a `dev-dependency` (`ifc-lite-clash` is already a geometry dev-dep, so `pub` it under a `test-support` feature of clash), or into core's `test-support`.
- Effort: S

### GEOM-34: Test RNGs duplicated (5x), one mislabelled
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/geometry/src/extrusion_byte_identity_tests.rs:354-373`, `rust/geometry/src/scalar_adjoint_tests.rs:404-422` (identical, jscpd), `rust/geometry/src/scan_outline/synth_tests.rs:15-35` (splitmix), `rust/geometry/src/kernel/arrangement/classify_tests.rs:85`, `rust/geometry/tests/issue_3353_unrecovered_crosstab.rs:114`; also `rust/processing/src/scan_segmentation/cylinder_fit.rs:196`.
- What: these are hand-rolled xorshift / splitmix generators. The extrusion copy is documented as "xorshift64*" but has no multiply step, so it is plain xorshift64. `proptest` is already a dev-dependency.
- Why it matters: minor, but it adds noise to every test file.
- Fix: one `test_support::Rng` (splitmix over `geom_hash::mix64`), or use proptest strategies.
- Effort: S

### GEOM-35: Fuzz-target byte decoders duplicated in `tests/fuzz_regressions.rs` "keep in sync"
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/geometry/fuzz/fuzz_targets/triangulate_polygon.rs:21-34` and `kernel_subtract.rs` vs `rust/geometry/tests/fuzz_regressions.rs:24-50`.
- What: the decoders are intentionally byte-identical by manual sync. The fuzz crate is a detached workspace (`edition = "2021"`), built only by the scheduled `fuzz.yml`.
- Why it matters: if the two drift, committed corpus files replay differently than they fuzzed.
- Fix: expose `ifc_lite_geometry::test_support::fuzz_inputs::{points_from_bytes, mesh_from_bytes}` under the `test-support` feature, and depend on it from both.
- Effort: S

### GEOM-36: Error type is stringly: one catch-all variant used 453 times, plus `Result<_, String>` in analytic/contour/scan_outline
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/error.rs:12-30` (all variants carry `String`; `Error::geometry(...)` has 453 uses crate-wide);
  - `Result<_, String>` in my area: `rust/geometry/src/analytic/profile.rs` (6), `analytic/profile_topology.rs` (6), `analytic/topology_interval.rs` (5), `analytic/extrusion.rs` (1), `contour_composition.rs` (6), `contour_bool2d.rs` (1), `contour_grid_guard.rs` (1), `scan_outline/options.rs` (3), `scan_outline/mod.rs` (1);
  - separate enums: `TerrainCdtError` (`terrain_cdt.rs:18`), `EditError` (`space_dcel/mod.rs:186`), `AnalyticStatus::Unsupported(String)`.
- What: callers cannot branch on failure kind. The router diagnostics re-classify failures by message text or by separate `BoolFailureReason` records.
- Why it matters: errors cannot be matched exhaustively, and wording changes silently break any string matching.
- Fix: introduce structured variants for the common classes (`MissingAttribute{entity, attr}`, `WrongType{expected, got}`, `NonFinite`, `Unsupported(kind)`). Convert `Result<_, String>` modules to `thiserror` enums at their pub boundary.
- Effort: L

### GEOM-37: Module-size ratchet produces flat sibling files, `#[path]` attachments and re-export chains instead of directories
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - flat siblings in `rust/geometry/src/`:
    - `geom_{hash,accumulate,bounds,closure,surface}.rs` (attached via `#[path]` in `geom_hash.rs:90-108`);
    - `mesh_{orient,orient_adjacency,weld,position_weld,tjunction}.rs` (`mesh.rs:938-942`, `mesh_orient.rs:37`);
    - `alignment_{arc_length,axis,sampling,sampling_curve,sampling_placement,tests,sampling_tests}.rs`;
    - `clash_{solid,solid_geom,contact_axes}.rs` (`clash_solid.rs:57`);
    - `contour_{bool2d,composition,grid_guard}.rs`, `curve_{segment,source}.rs`, `profile_{generic,skip}.rs`, `extrusion_generic.rs`;
  - re-export chain: `instancing/collate.rs:159-174` re-exports `dont_bake` / `verify` items that `instancing/mod.rs:120-124` re-exports again;
  - 101 `#[path]` attributes crate-wide; 95 entries in `src/`.
- What: each split names its reason as "keep X under the ratchet" (e.g. `clash_contact_axes.rs:8-10`, `profile_skip.rs:6`, `ring_geom.rs:7`), rather than a cohesive boundary. Test files are ratchet-exempt, which is why tests balloon (GEOM-8).
- Why it matters: ownership is hidden. `geom_closure.rs` looks like a top-level module but is a private child of `geom_hash`. Reviewers must chase `#[path]`s.
- Fix: convert each family into a directory module (`geom_hash/{mod,closure,bounds,surface,accumulate}.rs`, `mesh_topology/`, `alignment/`, `clash/`, `contour/`) with no `#[path]`. Apply the ratchet per directory, or exempt cohesive submodules.
- Effort: M

### GEOM-38: `calculate_polygon_normal` / `project_to_2d` / `is_convex` use absolute (scale-dependent) epsilons
- Category: Quirk
- Severity: Low
- Confidence: LIKELY
- Where: `rust/geometry/src/triangulation.rs:211` (`cross.abs() > 1e-10` in `is_convex`), `:497,506,525` (`len > 1e-10` in `calculate_polygon_normal`), `:442-443` (`project_to_2d` normalises with no zero guard).
- What: the cross product scales with edge length squared. Faces with edges under about 1e-5 m (or mm-authored files, before scaling) fall below 1e-10, so `is_convex` treats real turns as collinear and the normal falls back to +Z. A zero `normal` passed to `project_to_2d` yields NaN axes. `clash_contact_axes.rs:84-140` already documents and implements the scale-free (sin θ) alternative.
- Why it matters: tiny or degenerate faces triangulate in a wrong or NaN basis instead of failing cleanly.
- Fix: compare against `eps * |e1| * |e2|` (relative), and `try_normalize` with an explicit error in `project_to_2d`.
- Effort: S

### GEOM-39: `projection_outline::mesh_outline_2d` passes non-finite projected triangles to i_overlay; area constant off by 2x
- Category: Quirk
- Severity: Low
- Confidence: SUSPECT
- Where: `rust/geometry/src/projection_outline.rs:86` (`DEGENERATE_AREA`) and `:150-166`.
- What:
  - `area` is the cross product, i.e. twice the triangle area, but the constant is documented in "metres²".
  - With a NaN position, `area.abs() < DEGENERATE_AREA` is false and so is the aspect filter, so the NaN path is pushed to `overlay`. The i_overlay float adapter's behaviour on NaN bounds is unverified: it may produce garbage or panic in debug.
- Why it matters: this is a public API (`pub mod projection_outline`) consumed by wasm drawing generation.
- Fix: `if !area.is_finite() { continue; }`, and either halve the comparison or fix the doc. Share the triangle-area helper from GEOM-14.
- Effort: S

### GEOM-40: `opening-perf-trace` feature: 73 cfg sites, undocumented in rust/AGENTS.md feature list
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - feature declaration: `rust/geometry/Cargo.toml` (`opening-perf-trace`);
  - cfg sites: `rust/geometry/src/kernel/nary_union.rs` (10), `csg/group_cut.rs` (8), `csg/consolidate/ring_ops.rs` (8), `router/voids/staged.rs` (8), `router/voids/prism_cut.rs` (5), `router/voids/coaxial_union3d.rs` (5), `csg/mod.rs` (5), and others;
  - `rust/AGENTS.md` (lists only `observability`, `csg_capture`, `debug_geometry` as "the other opt-in features").
- What: there are 10 features in total, and three of them are measurement-only (`opening-perf-trace`, `csg_capture`, `debug_geometry`). They overlap in purpose with `observability`, and `kernel/plane_weld.rs:31,74` uses `any(observability, csg_capture, debug_geometry)` as an ad-hoc "telemetry on" predicate. Feature naming mixes snake_case and kebab-case (`csg_capture` vs `opening-perf-trace`, `triangulation-alt`, `test-support`). CI covers the feature combinations well (test.yml:2489-2754).
- Why it matters: the crate has cfg soup across about 90 sites. A new telemetry counter must pick among four features.
- Fix:
  - Define one `cfg_alias` (e.g. `#[cfg(telemetry)]` via a build-free `cfg_if` or a `telemetry` feature that the others enable) instead of repeating `any(...)`.
  - Normalise feature names to kebab-case.
  - Document all 10 features in `rust/AGENTS.md`.
- Effort: S

## Concept inventory

**Vector / matrix math**
- `geom2d::{line_intersection, polygon_area, point_in_polygon, perp_distance, orientation, on_segment, segments_intersect}`: `rust/geometry/src/geom2d.rs:26-115`
- `space_dcel::geom2d::{point_in_quad, representative_point, is_simple_polygon}`: `rust/geometry/src/space_dcel/geom2d.rs:14,42,92`
- `space_dcel::arrangement::segment_intersection_param`: `rust/geometry/src/space_dcel/arrangement.rs:276`
- `clash_contact_axes::{canonical, dot3, cross3, normalize3, face_normal}`: `rust/geometry/src/clash_contact_axes.rs:37,52,56,81,123`
- `mesh_tjunction::{pos_of, dist, height}`: `rust/geometry/src/mesh_tjunction.rs:30,35,40`
- `scan_outline::topology::{sub, dot, bbox, box_contains}`: `rust/geometry/src/scan_outline/topology.rs:345-363`
- `scan_outline::fit::dist`: `rust/geometry/src/scan_outline/fit.rs:209`
- `scan_outline::snap::dist`: `rust/geometry/src/scan_outline/snap.rs:285`
- `scan_outline::simplify::dist2`: `rust/geometry/src/scan_outline/simplify.rs:178`
- `contour_grid_guard::distance` (point-segment): `rust/geometry/src/contour_grid_guard.rs:15`
- `analytic::topology_interval::{dot, divide, trig}` (interval arithmetic): `rust/geometry/src/analytic/topology_interval.rs:13-36`
- `scalar::transform_point4` / `GeomScalar`: `rust/geometry/src/scalar.rs:114`
- `instancing::collate::mat4_to_row_major_f32`: `rust/geometry/src/instancing/collate.rs:28`
- row-major flatten loop: `rust/geometry/src/instancing/dont_bake.rs:21-30`
- `triangulation::{calculate_polygon_normal, project_to_2d, project_to_2d_with_basis}`: `rust/geometry/src/triangulation.rs:482,416,458`

**Transforms / placements**
- `transform::{parse_axis2_placement_3d, parse_axis2_placement_3d_from_id, build_axis2_matrix, rotation_angle_about_z}`: `rust/geometry/src/transform.rs:26,233,79,323`
- `transform::placement_2d::parse_axis2_placement_2d`: `rust/geometry/src/transform/placement_2d.rs:14`
- `instancing::collate::{compose_world, to_post_rtc}`: `rust/geometry/src/instancing/collate.rs:17,~145`
- `instancing::dont_bake::{compose_instance_world_row_major, instance_rel_row_major_f32, bake_source_at_world}`: `rust/geometry/src/instancing/dont_bake.rs:21,39,59`
- `extrusion_generic::apply_transform_generic`: `rust/geometry/src/extrusion_generic.rs:387`
- `MeshSink::transform_normals` (f64 impl): `rust/geometry/src/scalar.rs:182`
- `curve_segment::read_placement`: `rust/geometry/src/curve_segment.rs:101`
- `curve_source::circle_basis`: `rust/geometry/src/curve_source.rs:188`
- `alignment_sampling_placement::validate_placement` (chain validator): `rust/geometry/src/alignment_sampling_placement.rs:11`
- `world_frame_fixture::placed_box_mesh`: `rust/geometry/src/world_frame_fixture.rs:45`

**Tolerances / epsilons**
- `grid::{NORMAL_QUANT_F64, NORMAL_QUANT_F32}`: `rust/geometry/src/grid.rs:17,21`
- `geom2d::PARALLEL_EPS = 1e-9`: `rust/geometry/src/geom2d.rs:22`
- `space_dcel::{EPS = 1e-9, EPS_COLL = 1e-6}`: `rust/geometry/src/space_dcel/mod.rs:223,228`
- `bool2d::{EPSILON_2D = 1e-9, MIN_AREA_THRESHOLD = 1e-10}`: `rust/geometry/src/bool2d.rs:20,23`
- `clash_contact_axes::{ORTHO_EPS = 1e-4, MIN_SIN_THETA = 1e-3}`: `rust/geometry/src/clash_contact_axes.rs:32,118`
- `clash_solid::TRUST_BAND_MULTIPLE`: `rust/geometry/src/clash_solid.rs:69`
- `instancing::verify::{ABS_FLOOR_M = 1e-6, ULP_FACTOR = 2^-20}`: `rust/geometry/src/instancing/verify.rs:74,76`
- `mesh_orient::WELD_SCALE = 1e5`: `rust/geometry/src/mesh_orient.rs:49`
- `mesh_weld::UV_QUANT = 1e3`: `rust/geometry/src/mesh_weld.rs:120`
- `geom_hash::{DEFAULT_GEOM_HASH_TOLERANCE = 1e-3, MIN_GEOM_HASH_TOLERANCE = 1e-6}`: `rust/geometry/src/geom_hash.rs:142,159`
- `projection_outline::DEGENERATE_AREA = 1e-8`: `rust/geometry/src/projection_outline.rs:86`
- `zone_split::{NEGLIGIBLE_PIECE_REL, NO_VOLUME_REL}`: `rust/geometry/src/zone_split.rs:208,215`
- `analytic::profile::DEFAULT_TOPOLOGY_CLEARANCE = 1e-9`: `rust/geometry/src/analytic/profile.rs:17`
- `scan_outline` angle and cell constants: `rust/geometry/src/scan_outline/{snap.rs:29-35, fit.rs:14-17, square.rs:24-27, grid.rs:15-19, options.rs:15-19}`
- `curve_segment::MAX_STEP`: `rust/geometry/src/curve_segment.rs:27`
- `world_frame_fixture::normal_projected_noise_bound` / `ulp32`: `rust/geometry/src/world_frame_fixture.rs:107`
- inline literals: `transform.rs:96-98` (1e-9, 1e-6, 0.9), `triangulation.rs:211,497` (1e-10)

**Unit conversion**
- `alignment_sampling::resolve_scale` (dual-resolver agreement check): `rust/geometry/src/alignment_sampling.rs:198`
- plane-angle use: `rust/geometry/src/analytic/mod.rs:229` (`decoder.plane_angle_to_radians()`), `rust/geometry/src/curve_source.rs:257`
- `profile::calculate_circle_segments`, `tessellation::{scale_segments, TessellationQuality::circle_profile_segments}` (segment counts): `rust/geometry/src/profile.rs:299`, `rust/geometry/src/tessellation.rs:161,179`

**BBox / AABB**
- `triangulation::ring_geom::ring_bbox`: `rust/geometry/src/triangulation/ring_geom.rs:10`
- `scan_outline::topology::bbox`: `rust/geometry/src/scan_outline/topology.rs:345`
- `ContourSet::bounds`: `rust/geometry/src/contour_bool2d.rs:95`
- `zone_split::{tris_aabb, ZoneShape::world_aabb, ZoneBox::world_aabb}`: `rust/geometry/src/zone_split.rs:324,76,139`
- `geom_bounds::{extend_bounds, world_aabb}`: `rust/geometry/src/geom_bounds.rs:29,82`
- `scan_outline::grid::robust_extent`: `rust/geometry/src/scan_outline/grid.rs:182`
- `Profile2D::center_on_bbox`: `rust/geometry/src/profile.rs:46`

**Hashing / quantisation**
- `geom_hash::{mix64, fold_i64, quantize, GeometryHasher, hash_mesh_world}`: `rust/geometry/src/geom_hash.rs:165,173,181`
- `geom_accumulate::quantize_corner`: `rust/geometry/src/geom_accumulate.rs:36`
- `mesh_weld::vkey` (bits + quantised normal/uv): `rust/geometry/src/mesh_weld.rs:125`
- `mesh_position_weld::weld_impl` (`q_pos` f32 grid): `rust/geometry/src/mesh_position_weld.rs:18,28`
- `mesh_tjunction::key_of` (bits): `rust/geometry/src/mesh_tjunction.rs:25`
- `mesh_orient` `q` closure (`WELD_SCALE`): `rust/geometry/src/mesh_orient.rs:203`
- clash_solid bit-key weld: `rust/geometry/src/clash_solid.rs:257`, `rust/geometry/src/clash_solid_geom.rs:96`
- `terrain_cdt` signed-zero-canonical key: `rust/geometry/src/terrain_cdt.rs:70`
- `test_support::open_edges` (bits): `rust/geometry/src/test_support.rs:20`
- `UnionFind`: `rust/geometry/src/union_find.rs:13`
- inline union-find: `rust/geometry/src/clash_solid_geom.rs:79`

**Triangulation / polygon ops**
- `triangulation::{safe_earcut, ear_clip, triangulate_polygon, triangulate_polygon_with_holes, triangulate_polygon_with_holes_refined, quad_indices, fan_triangulate, is_convex}`: `rust/geometry/src/triangulation.rs:59,51,277,316,370,256,266,195`
- `triangulation::alt_oracle::{set_alt_triangulator, maybe_earcut}`: `rust/geometry/src/triangulation/alt_oracle.rs`
- `terrain_cdt::{triangulate_terrain_pslg, triangulate_terrain_pslg_with_progress}`: `rust/geometry/src/terrain_cdt.rs`
- `bool2d::{subtract_2d, subtract_multiple_2d(_counted), subtract_staged_2d_counted, union_contours_to_shapes, compute_signed_area, ensure_ccw, ensure_cw, point_in_contour, is_valid_contour}`: `rust/geometry/src/bool2d.rs:38-241`
- `contour_bool2d::{boolean_2d, boolean_2d_fixed_grid, sanitize, resolve, collect}`: `rust/geometry/src/contour_bool2d.rs:176-300`
- `contour_composition::FixedGridComposition::overlay`: `rust/geometry/src/contour_composition.rs:88`
- `projection_outline::mesh_outline_2d`: `rust/geometry/src/projection_outline.rs:112`
- `zone_split::split_mesh_by_zones`: `rust/geometry/src/zone_split.rs:241`
- `scan_outline::trace_scan_outline`: `rust/geometry/src/scan_outline/mod.rs:120`
- `space_dcel::SpacePlate::{build, build_from_wall_rects, net_outline, gap_boundary}`: `rust/geometry/src/space_dcel/mod.rs:243,270,927,1040`
- `mesh_orient::{orient_mesh_outward, orient_mesh_outward_verdict}`: `rust/geometry/src/mesh_orient.rs:157,166`
- `mesh_tjunction::split_across_dropped_slivers`: `rust/geometry/src/mesh_tjunction.rs:85`
- `mesh_weld::weld_indexed`: `rust/geometry/src/mesh_weld.rs:182`

**Entity attribute access / decoding**
- `transform::{parse_cartesian_point, parse_decoded_cartesian_point, parse_cartesian_point_from_id, parse_direction, parse_direction_from_id}`: `rust/geometry/src/transform.rs:133,159,186,286,225`
- `curve_source::{invalid, resolve, point_values, point_from_ref, vector_from_ref, line_basis, mesh_line_basis, trim_point, circle_basis, trim_angle}`: `rust/geometry/src/curve_source.rs:10-262`
- `analytic::read_optional_numeric`: `rust/geometry/src/analytic/mod.rs:320`
- `analytic::composite_parent_parameter_span`: `rust/geometry/src/analytic/mod.rs:337`
- `trimmed_curve::decode_trimmed_primitive`: `rust/geometry/src/trimmed_curve.rs:41`
- `gradient::GradientProfile::from_curve` / `parse_segment`: `rust/geometry/src/gradient.rs:65,132`
- `alignment_axis::locate_axis_curve`: `rust/geometry/src/alignment_axis.rs:23`
- `alignment_sampling_placement::validate_vector`: `rust/geometry/src/alignment_sampling_placement.rs:78`

**Colour / style resolution**
- `examples/color_extraction_test.rs`: `build_geometry_style_index:308`, `build_element_style_index:351`, `find_color_for_geometry:433`, `extract_color_from_*:480-562` (stale duplicate of processing::style)

**Error types**
- `Error` (`TriangulationError`, `InvalidProfile`, `InvalidExtrusion`, `EmptyMesh` [dead], `GeometryError`, `CoreError`) and `Result`: `rust/geometry/src/error.rs:8-36`
- `BoolOp`, `BoolFailureReason`, `BoolFailure`: `rust/geometry/src/diagnostics.rs:49,72`
- `TerrainCdtError`: `rust/geometry/src/terrain_cdt.rs:18`
- `EditError`: `rust/geometry/src/space_dcel/mod.rs:186`
- `DegenerateReason` / `IntersectionSolid`: `rust/geometry/src/clash_solid.rs:74`
- `AnalyticStatus::Unsupported(String)`: `rust/geometry/src/analytic/mod.rs:124`
- `AlignmentSamplingDiagnosticCode`: `rust/geometry/src/alignment_sampling.rs:64`
- `NoOutline`: `rust/geometry/src/projection_outline.rs:96`
- `Result<_, String>`: `analytic/*`, `contour_*`, `scan_outline/options.rs`

**Global state / telemetry (for the cross-crate pass)**
- `progress::{set_hook, tick, tick_strided}`: `rust/geometry/src/progress.rs:28-54`
- `telemetry_transaction::{record, Transaction}`: `rust/geometry/src/telemetry_transaction.rs:16-80`
- `csg_capture` (`CAPTURED`, `CAPTURE_ENABLED`): `rust/geometry/src/csg_capture.rs:37,45`
- `opening_perf_trace::Counters`: `rust/geometry/src/opening_perf_trace.rs:15,126`
- `diagnostics::PENDING_MAPPED_BOOL_FAILURES`: `rust/geometry/src/diagnostics.rs:37`
- env-flag `OnceLock`s: GEOM-20 list
