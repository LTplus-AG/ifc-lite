# Cross-cutting (workspace-level) review

Scope: everything that spans crates in `rust/*` and `apps/server` — semantic duplication of the same concept across crate boundaries, dependency hygiene, error-handling strategy, repo-wide hygiene numbers, docs-vs-code drift. Per-crate internals are left to the crate reviewers except where a crate-local copy is one instance of a cross-crate concept.

Numbers below were produced with `rg` and `python3 -I` scripts under `/tmp/xcut`; "non-test" means excluding `tests/`, `*_tests.rs`, `tests.rs`, `examples/`, `benches/` and `generated/`.

## Summary

- **The workspace has no shared math layer, so every crate grew its own.** Vector dot/cross/normalize over `[f64;3]` exists in 14 private copies across 5 crates, row-major 4×4 multiply/invert/compose in 4, AABB min/max folds in ~40 sites, Z-up→Y-up frame swap in 6 "single homes", polygon normal/area in 11, signed volume in 4 production + 20 test copies. Several copies have drifted on the numeric guard (normalize ε of 0 / 1e-12 / 1e-10 / 1e-9 / 1e-6 / 1e-4 f32; affine-singular det 1e-18 vs 1e-24; placement-walk depth 50 vs 100), and one copy (`profiles/curves_3d.rs:102`) still calls bare `.normalize()` and can emit NaN. (XCUT-1..5, 8, 26)
- **IFC entity reading is re-implemented per consumer instead of once in core.** `IfcAxis2Placement3D` is read 9 ways in geometry/processing, `IfcCartesianPoint`/`IfcDirection` 12 ways plus 60 inline `coords.first().and_then(|v| v.as_float()).unwrap_or(0.0)` triplets, the placement chain walk 9 ways, `IFCPROJECT` is located by 12 separate scanners, and the length-unit → metres rule lives in 4 places with 3 SI-prefix tables. (XCUT-1, 2, 6, 34)
- **Four parallel data-model pipelines decode property sets / quantities / spatial containment / materials:** `apps/server/src/services/data_model` (3.3 kLOC, with its own 6.5 kLOC generated schema tables produced by a *second* code generator fed from the TypeScript registry), `rust/export` (model/quantity/relationships, 1.8 kLOC + its own generated slot tables), `rust/processing/processor/{properties,quick_metadata}.rs`, and `rust/python/entity_data.rs` — because `apps/server` does not depend on `ifc-lite-export`. (XCUT-7)
- **Dependency manifest hygiene is weak:** `[workspace.dependencies]` lists only the internal crates, so `nalgebra`, `serde`, `serde_json`, `rayon`, `rustc-hash`, `memchr`, `thiserror`, `png`, `sha2` are each declared 2–8 times with per-crate version strings; `sha2` is already split (0.10 in processing, 0.11 in server → two digest stacks compiled); 7 declared deps are never referenced (`smallvec`, `memchr`×2, `thiserror`, `futures-util`, `wasm-bindgen-futures`, `tokio-stream`); internal deps use three different declaration styles. (XCUT-16..18)
- **Error handling has seven coexisting policies** (thiserror enums in core/geometry/server; `Result<_, String>` ×258 in processing/export/geometry/landxml/cloud-import; `Box<dyn Error>` ×41 in landxml; hand-written `Display` impls ×6 in export; `JsValue`/`JsError` strings ×85 in wasm; `anyhow` in server main). `Error::geometry(String)` is called 451 times — the typed enum is a String wrapper in practice. (XCUT-15)
- **Repo hygiene is actually good on the classic axes** (unwrap+expect density 0.4–1.0 per kLOC in the core crates, 5 TODOs in 300 kLOC, 24 SAFETY comments for 14 kernel `unsafe` uses), but concentrated in a few god files/functions (5 files >1500 lines, 54 non-generated functions ≥200 lines, `apply_void_context_inner` 781 lines) and a 461-row module-size allowlist; `landxml` is the outlier at 4.8 `expect()`/kLOC. (XCUT-21..23)
- **A hidden runtime-config surface**: 13 `IFC_LITE_*` env-var toggles read into `OnceLock` statics across geometry/processing, plus 13 Cargo features with inconsistent naming (`csg_capture` vs `csg-capture`), plus 5 process-global `AtomicBool/AtomicI8` overrides — none catalogued in any AGENTS.md. (XCUT-20)
- Docs drift is minor but real: `rust/AGENTS.md`'s lint-inheritance list and "other opt-in features" sentence are stale, `union_many` is not in `mesh_bridge.rs`, the user-facing diagnostic string still says "(BSP unsafe)" for a kernel that was deleted, and three `#[allow(dead_code)]` lack the "why" the root AGENTS.md mandates. (XCUT-24)

## Findings

### XCUT-1: `IfcAxis2Placement3D` is read nine different ways
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - rust/geometry/src/transform.rs:26 `parse_axis2_placement_3d` (canonical; `try_normalize(1e-9)` inside `build_axis2_matrix`)
  - rust/geometry/src/transform.rs:233 `parse_axis2_placement_3d_from_id` (fast-path twin of the above, same body with `_from_id` readers)
  - rust/geometry/src/processors/helpers.rs:31 `parse_axis2_placement_3d` (adds "null Location → origin", otherwise identical)
  - rust/geometry/src/profile_extractor.rs:603 `parse_axis2_placement_3d` (`.map(..).transpose()` style, location `unwrap_or(origin)`)
  - rust/geometry/src/router/transforms/parsers.rs:16 `GeometryRouter::parse_axis2_placement_3d` (method copy of transform.rs:26)
  - rust/geometry/src/processors/advanced_face/conics.rs:13 `read_axis2_placement_3d` (returns a frame; `try_normalize(1e-12)`; different parallel-axis fallback: smallest-|dot| basis vector instead of `build_axis2_matrix`'s `z.z<0.9` rule)
  - rust/geometry/src/profiles/curves_3d.rs:64 `read_conic_placement_3d` (bare `.normalize()`; z-component default `unwrap_or(1.0)` instead of `0.0`; inline coordinate reads)
  - rust/geometry/src/profiles/mod.rs:782 `axis2_placement_location_and_x_axis_3d` (2D/3D, `norm() > 1e-12`)
  - rust/geometry/src/curve_segment.rs:101 `read_placement` (2D/3D → heading)
  - rust/processing/src/symbolic/transform.rs:193 `parse_axis2_placement_2d` (3D-or-2D → `Transform2D`, **f32**, length guard `0.0001`)
  - 2D only: rust/geometry/src/transform/placement_2d.rs:14, rust/geometry/src/profiles/placement.rs:214, rust/geometry/src/router/transforms/mapped.rs:135 (delegates)
- What: Only four of the nine share `build_axis2_matrix`; the others carry their own orthonormalisation with different ε and a different degenerate-axis fallback. The attribute-extraction half (Location/Axis/RefDirection with null and dangling-ref handling) is copy-pasted in every one. `transform.rs:68` even documents the fork: "Every IfcAxis2Placement3D parser in the crate keeps its own attribute extraction / default-axis choices and shares only this orthonormalization".
- Why it matters: A malformed placement is interpreted differently depending on which representation it sits under (a conic edge in an advanced face vs a swept-solid position vs a 2D symbolic item). `curves_3d.rs:102` produces NaN for a zero Axis (see XCUT-26) where the others fall back to +Z. Any future fix (e.g. #2256-style "unresolved, not identity") has to be applied nine times.
- Fix: One `ifc_lite_geometry::transform::Axis2Placement` reader: `fn read(entity, decoder) -> Result<Axis2Frame { location, axis: Option<Vector3>, ref_direction: Option<Vector3>, is_2d }>` with the null/dangling policy decided once, plus `impl Axis2Frame { fn matrix(&self) -> Matrix4; fn frame(&self) -> (Point3, Vector3, Vector3); fn heading_xy(&self) -> f64; fn transform_2d(&self, scale) -> Transform2D }`. Delete the eight bodies; keep `build_axis2_matrix` as the only orthonormaliser.
- Effort: M

### XCUT-2: `IfcCartesianPoint` / `IfcDirection` coordinate reading has 12 named copies and 60 inline copies
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where (named): rust/core/src/decoder.rs:615 `get_cartesian_point_fast`, :714 `parse_cartesian_point_inline`, :748 `parse_point_coordinates`; rust/geometry/src/transform.rs:134 `parse_cartesian_point`, :159 `parse_decoded_cartesian_point`, :186 `parse_cartesian_point_from_id`, :225 `parse_direction_from_id`, :286 `parse_direction`; rust/geometry/src/processors/helpers.rs:83 `parse_cartesian_point`, :121 `parse_direction`; rust/geometry/src/profile_extractor.rs:647 `parse_cartesian_point`, :677 `parse_direction_entity`; rust/geometry/src/router/transforms/parsers.rs:61 `parse_cartesian_point`, :100 `parse_direction`; rust/geometry/src/router/transforms/operator.rs:234 `parse_direction_ratios`; rust/geometry/src/processors/sectioned_positions.rs:162 `read_direction`; rust/geometry/src/curve_source.rs:40 `point_from_ref`.
- Where (inline `coords.first().and_then(|v| v.as_float()).unwrap_or(0.0)` triplets, non-test): 60 occurrences in 12 files — rust/geometry/src/profiles/curves_3d.rs (8), profiles/placement.rs (5), processors/advanced_face/polyline.rs (4), rust/processing/src/symbolic/operator.rs (3), rust/geometry/src/transform.rs (3), profile_extractor.rs (3), rust/core/src/schema_gen.rs (3), rust/processing/src/symbolic/{transform,items,fill}.rs (2 each), rust/geometry/src/router/transforms/{parsers,operator}.rs (2 each).
- What: `helpers.rs:83-119` and `router/transforms/parsers.rs:61-99` are byte-identical except for `&self`. Defaults differ between copies: missing z → `0.0` everywhere except curves_3d.rs:105 (`1.0`); missing x on a direction → `1.0` in curves_3d.rs:128/177 and symbolic/transform.rs:238, `0.0` elsewhere; type checks (`ifc_type != IfcCartesianPoint`) present in some, absent in others.
- Why it matters: Same malformed point decodes to different coordinates depending on the call site; 60 inline copies cannot be audited for the "2-coordinate point in a 3D slot" rule.
- Fix: `ifc_lite_core::DecodedEntity::{coords3(&self) -> Option<[f64;3]>, direction3(&self) -> Option<[f64;3]>}` (and `coords2`) with one documented padding rule, plus `EntityDecoder::point3_at(entity, slot)`. Geometry's `transform.rs` wrappers become one-liners over it; delete the other eleven.
- Effort: M

### XCUT-3: Vector math over `[f64;3]` is implemented 14 times in 5 crates (plus nalgebra, plus Plato-generated)
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - rust/clash/src/vec3.rs:16-68 (`Vec3 = [f64;3]`, sub/add/scale/cross/dot/dist_sq/mid/centroid as adapters over the Plato-generated rust/clash/src/generated/plato.rs:157 `Vec3` struct, 355 lines, `#![allow(clippy::all)]`) and rust/clash/src/obb_detect.rs:16 `normalize` (`!(len > OBB_EPS=1e-6)`)
  - rust/geometry/src/clash_contact_axes.rs:52 `dot3`, :56 `cross3`, :81 `normalize3` (`len == 0.0` guard), :37 `canonical` (verbatim copy of clash obb_detect.rs:27 `canonical` — jscpd 14-line clone, because clash must stay zero-dep)
  - rust/geometry/src/kernel/arrangement/classify.rs:17 `cross3`, :20 `dot3`
  - rust/geometry/src/kernel/tritri.rs:46 `cross_f64`, `sub_f64`
  - rust/geometry/src/kernel/rational.rs:49 `sub3`, :61 `cross` (BigRational), rust/geometry/src/kernel/fixed.rs:69 `sub3`, :72 `cross` (fixed-int) — legitimately separate numeric types
  - rust/geometry/src/router/voids/prism_cut.rs:222-265 `dot/sub/add/scale/cross/norm/normalize(1e-12)/lerp` ("explicit component arithmetic so no FMA can sneak in")
  - rust/processing/src/appearance/transfer_math.rs:8-19 `sub/dot/cross` (`dot` via `iter().zip().sum()`)
  - rust/processing/src/appearance/authored.rs:18-27 `dot/cross`; calibration.rs:36-39 `dot/length` (`hypot` chain); mapping.rs:31-36 `dot/subtract`
  - rust/processing/src/scan_proposals/frame.rs:14-25 `add/scale/norm/unit(1e-12)` (reuses transfer_math for the rest)
  - rust/export/src/geom.rs:231 `dot`, :26 `dist`; rust/export/src/openings.rs:18 `sub`, :19 `norm` (zero → zero vector)
  - 2D: rust/processing/src/pdf_vector/strokes.rs:23 `cross/dot`; rust/geometry/src/scan_outline/topology.rs:358 `sub/dot`; rust/processing/src/scan_segmentation/ring.rs:81 `dot2`, :89 `length2`
- What: Three vector representations coexist (`nalgebra::Vector3` re-exported from geometry lib.rs:201, bare `[f64;3]` with free functions, Plato `Vec3`) and the free functions are re-typed per module. The normalisation guard is the drift point: `0`/`== 0.0` (clash_contact_axes, export/openings), `1e-12` (prism_cut, scan_proposals, conics), `1e-10` (profiles/placement.rs:206), `1e-9` (transform.rs), `1e-6` (clash OBB_EPS), `1e-4` f32 (symbolic). `dot` is summed in three different orders (explicit `a0*b0 + a1*b1 + a2*b2`, `iter().zip().sum()`, `hypot` chains), which is not bit-identical — the repo's determinism manifests pin outputs that pass through `prism_cut`'s explicit version precisely because of this.
- Why it matters: Identical geometry gets a different "degenerate" verdict per call site; a future change to the rounding policy (e.g. forbidding FMA) must be found in 14 places; clash and geometry already carry a verbatim clone to avoid a dependency.
- Fix: A zero-dependency `ifc-lite-math` crate (or `ifc_lite_core::math` — core is already dependency-light and clash could take it without violating "zero deps" if the math is split out) exporting `v3::{dot, cross, sub, add, scale, norm, normalize(eps) -> Option, lerp}`, `v2::*`, with one documented accumulation order and one `NORMALIZE_EPS`. Make the Plato adapter the one and only consumer of the generated struct, or drop Plato (it generates 355 lines to express 8 one-liners).
- Effort: M

### XCUT-4: Row-major 4×4 matrix helpers (multiply, affine inverse, compose, identity, row/col flatteners) duplicated across geometry, processing, export, wasm, server
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - multiply: rust/export/src/gltf/matrix.rs:54 `mat4_mul`; rust/processing/src/simplify_math.rs:44 `matmul_row_major`; rust/wasm-bindings/src/zero_copy/frame_swap.rs:48 nested `matmul`; apps/server/src/services/parquet_instancing.rs:219 `mat3_mul`
  - affine inverse: rust/export/src/gltf/matrix.rs:155 `affine_inverse` (singular if `det.abs() < 1e-18`); rust/processing/src/simplify_math.rs:70 `invert_affine_row_major` (`!det.is_finite() || det.abs() < 1e-24`); rust/geometry/src/instancing/dont_bake.rs:47 via `nalgebra::try_inverse` (its own ε)
  - compose `transform·local·canonical`: rust/geometry/src/instancing/collate.rs:17 `compose_world` (nalgebra), rust/geometry/src/instancing/dont_bake.rs:21 `compose_instance_world_row_major` (**pub**), rust/export/src/gltf/matrix.rs:198 `compose_world_meta` (re-implements the same product with the local `mat4_mul` instead of calling the pub geometry fn)
  - identity constants: rust/geometry/src/instancing/collate.rs:9 `IDENTITY16`, rust/export/src/gltf/matrix.rs:46 `IDENTITY16`, rust/geometry/src/router/processing.rs:21 `IDENTITY_ROW_MAJOR`, rust/wasm-bindings/src/api/alignment_lines.rs:125 `IDENTITY`, apps/server/src/services/parquet_instancing.rs:280 `IDENTITY_ROTATION`
  - flatteners: rust/geometry/src/router/transforms/mod.rs:100 `mat4_to_col_array`, :108 `mat4_to_row_major`; rust/geometry/src/instancing/collate.rs:28 `mat4_to_row_major_f32`; rust/export/src/gltf/matrix.rs:143 `row_major_f64_to_col_major_f32`; rust/geometry/src/profile_extractor.rs:~735 column-major f32 with Y/Z swap
  - apply: rust/processing/src/simplify_math.rs:60 `transform_point_row_major`; apps/server/src/services/parquet_instancing.rs:125 `apply_r_t`; rust/export/src/geom.rs:17 `xf`
  - identity test: rust/geometry/src/router/layers.rs:535 `matrix_is_identity` (ε 1e-9, 4×4), rust/processing/src/mesh_frame.rs:22 `PLACEMENT_IDENTITY_EPSILON` + `rotation_is_identity` (ε 1e-9, 3×3 block)
- What: The glTF exporter and the demesher each carry a full hand-rolled affine inverse with different singularity thresholds (1e-18 vs 1e-24, and only one checks `is_finite`); the exporter re-derives a product that geometry already exports publicly.
- Why it matters: A near-singular placement (det between 1e-24 and 1e-18) is "instanceable" for the demesher and "fall back to flat" for glTF — two consumers of the same `InstanceMeta` disagree. Each copy is ~40 lines of index arithmetic that is easy to transpose wrongly (the gltf/matrix.rs doc comment is 40 lines of frame-convention reasoning precisely because the row/col conventions are hand-managed).
- Fix: `ifc_lite_geometry::mat4` module over row-major `[f64;16]`: `IDENTITY`, `mul`, `affine_inverse(eps)`, `transform_point`, `to_col_major_f32`, `from_nalgebra/to_nalgebra`, `is_identity(eps)`, with `SINGULAR_DET_EPS` defined once. Export/processing/wasm/server import it (all already depend on geometry).
- Effort: M

### XCUT-5: The IFC Z-up → WebGL Y-up frame swap has six "single homes"
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - rust/wasm-bindings/src/zero_copy/frame_swap.rs:25 `swap_zup_to_yup_aabb`, :34 `swap_zup_to_yup_mat4` ("in one place")
  - apps/server/src/services/axis.rs:22 `zup_to_yup`, :30 `zup_to_yup_f64`, :40 `mesh_to_yup_in_place` ("The ONE definition of the server wire's axis convention"), plus apps/server/src/services/parquet_instancing.rs:216 `P_ZUP_TO_YUP`/`P_ZUP_TO_YUP_T` and :236 `rotation_zup_to_yup`
  - rust/export/src/frame.rs:20 `yup_f32`, :26 `yup_f64`, :40 `yup_matrix4` (column-major), :91 `to_yup_into`, :115 `to_yup_in_place`
  - rust/export/src/gltf/matrix.rs:33 `S_YUP`, :40 `S_YUP_INV` (row-major)
  - rust/export/src/geom.rs:12 `zup` (inverse), rust/export/src/collada.rs:34 `to_zup` (inverse)
  - rust/processing/src/simplify_math.rs:13 `yup_to_zup`, :20 `zup_to_yup`, :26 `conjugate_yup_to_zup` with `S`/`ST` consts that are a verbatim copy of frame_swap.rs:36-47 (jscpd `processing/src/simplify_math.rs:28-41 <-> wasm-bindings/src/zero_copy/frame_swap.rs:35-48`)
- What: The same permutation `(x,y,z)→(x,z,-y)` and its matrix conjugation are written out in point, AABB (with the min/max reversal subtlety documented only in frame_swap.rs), 3×3, column-major 4×4 and row-major 4×4 flavours, each with its own prose explaining why the naive version is wrong.
- Why it matters: The AABB corner-reversal bug that frame_swap.rs documents is not protected anywhere else; `export/frame.rs:40` and `gltf/matrix.rs` use opposite storage orders for the same `S`. A new transport will copy one of the six and pick the wrong one.
- Fix: `ifc_lite_processing::frame` (lowest crate every consumer shares): `zup_to_yup_{point_f32, point_f64, aabb6, mat4_row_major, mat4_col_major, mat3}` and the inverses, with the conjugation proved once in a unit test. Re-export in wasm/export/server; delete the other five.
- Effort: M

### XCUT-6: Length-unit resolution and `IFCPROJECT` location are implemented 4× and 12× respectively, with 3 SI-prefix tables
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - unit → metres: rust/core/src/units.rs:31 `extract_length_unit_scale`, :249 `try_extract_length_unit_scale` (near-duplicate bodies, jscpd `units.rs:264-282 <-> 361-378`); rust/core/src/georef.rs:493-545 (MapUnit: IfcSIUnit prefix + IfcConversionBasedUnit name table + `resolve_measure_with_unit`); rust/export/src/landxml_terrain_georef.rs:161 `length_unit_metres` (requires `Name == METRE`, rejects unknown); rust/export/src/merged/units.rs:108 `resolve_length_scale` (wraps decoder, adds finite/positive guard); rust/export/src/step_map_transform_preflight.rs:50-70 (own validation with an inline 16-arm `matches!` prefix list)
  - SI prefix tables: rust/core/src/unit_labels.rs:25 `try_si_prefix_multiplier` (authoritative), rust/export/src/step_log/units.rs:14 `SI_PREFIXES` (names only, in a different order), rust/export/src/step_map_transform_preflight.rs:65 inline `matches!`, rust/core/src/project_units/symbols.rs:16 `si_prefix_symbol`, rust/export/src/step_log/georef.rs:60 (another literal list)
  - unit-label normalisation: rust/core/src/unit_labels.rs:199 `infer_map_unit_scale` and rust/export/src/step_log/units.rs:96 `normalize_map_unit_name` implement the same tokenise/US-survey-foot/strip-plural algorithm twice (one returns a scale, one a canonical name)
  - `IFCPROJECT` locators: rust/core/src/decoder.rs:357 `length_unit_scale` (EntityScanner full scan); rust/geometry/src/router/mod.rs:297 `scan_unit_scale`; rust/geometry/src/profile_extractor.rs:747 `detect_unit_scale` (identical to the previous); rust/processing/src/prepass.rs:407 `find_ifcproject_id` (SIMD, oversized-id reporting); rust/wasm-bindings/src/api/alignment_lines.rs:82, api/styling/prepass.rs:57, api/gpu_meshes/prepass.rs:354; rust/export/src/model.rs:246, relationships.rs:59, quantity_analysis.rs:264, rebar_schedule_build.rs:30, step_log/units.rs:130; apps/server/src/services/data_model/mod.rs:156, spatial.rs:189, material_units.rs:29
- What: processing/prepass.rs:353 documents itself as "the only sanctioned place that hunts for IFCPROJECT", yet eleven other scanners exist, three of them O(file) `EntityScanner` walks that the prepass comment explicitly calls a "stall class". The rule "which IfcSIUnit counts as the length unit" differs: core returns the first `LENGTHUNIT` IfcSIUnit regardless of `Name`, landxml_terrain_georef and step_map_transform_preflight require `METRE` and error on multiples, merged/units adds a finite guard the others lack.
- Why it matters: A file declaring two length units, or `IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)` plus a conversion-based unit, is scaled differently by the mesher (core rule) and by the LandXML/STEP-map exporters (strict rule). The `extract`/`try_extract` pair in core is already a maintenance fork (two 100-line bodies).
- Fix: `ifc_lite_core::units::ProjectUnits { length_scale, length_unit_name, plane_angle_scale, project_id, resolution: Complete|Partial }` with one `resolve(content, decoder)` that uses the SIMD `find_ifcproject_id` (move it to core), one `si_prefix_multiplier`, one `conversion_based_unit_factor`, one label normaliser. Everything else (router, profile_extractor, exporters, server, wasm) consumes it; `try_extract` becomes `resolve(..).resolution == Partial`.
- Effort: M

### XCUT-7: Four parallel IFC data-model pipelines (property sets, quantities, spatial tree, materials, type relations) and two schema code generators
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - apps/server/src/services/data_model/{properties,quantities,relationships,materials,material_units,classifications,documents,spatial*,rooted,types,metadata}.rs — 3,297 non-test lines; schema knowledge from apps/server/src/services/data_model/generated/attr_indices.rs (`root_attr_indices`, a single 6,213-line `match`) and relationship_slots.rs (329-line fn), generated by `scripts/generate-server-attr-indices.mjs` from the **TypeScript** `SCHEMA_REGISTRY`
  - rust/export/src/{model.rs, model_props.rs, model_types.rs, model_inherit.rs, quantity_analysis*.rs, relationships.rs, materials.rs, classifications.rs} — 1,835 lines; schema knowledge from rust/export/src/generated/{ifc4_required_slots, ifc2x3_required_slots, step_log_tables}.rs
  - rust/processing/src/processor/properties.rs (400 lines) and quick_metadata.rs (313 lines)
  - rust/python/src/entity_data.rs
  - rust/core/src/generated/{schema,ifc2x3,ifc4,ifc4x1,ifc4x2}/ (EXPRESS-derived, `@ifc-lite/codegen`) already exposing `attribute_index` (rust/core/src/decoder/schema_layout.rs:49, generated schema.rs:7597) — which the server never calls (`rg attribute_names apps/server/src` → 0)
  - identical helpers: rust/export/src/model_props.rs:20 `fmt_num` ≡ apps/server/src/services/data_model/property_value.rs:304 `fmt_number` (byte-identical bodies)
- What: `apps/server/Cargo.toml` depends on core/geometry/processing but **not** on `ifc-lite-export`, so the server re-implements pset/quantity/spatial/material extraction, its own Parquet writer family (`services/parquet*.rs`, 19 files) beside export's `parquet_bos.rs`, and its own schema-position tables. The two generators (EXPRESS → core, TS registry → server) encode the same attribute positions; `scripts/check-server-browser-type-parity.mjs` exists only to keep them from disagreeing.
- Why it matters: The AGENTS.md promise "Domain logic lives in Rust crates under rust/* and is the source of truth for the server, CLI, SDK, and wasm" is false for the data model: the server's answer for a property value, a storey elevation or a material comes from a different decoder than the CLI/SDK (export crate) and the wasm (processing). Every schema version bump needs two generators and a parity script.
- Fix: (1) Extract the entity-data layer of `rust/export` (model/model_props/quantity_analysis/relationships/materials/classifications) into `ifc-lite-model` (or a `model` module of processing, which the server already depends on); (2) have the server consume it and delete `data_model/{properties,quantities,relationships,materials,classifications}.rs`; (3) replace `generated/attr_indices.rs` with `IfcSchema::attribute_index` from core (one generator); (4) move the server's Parquet writers onto export's `parquet-bos` feature or vice versa. Do this incrementally per table (psets first — the server tests in data_model/tests.rs are 2,487 lines and can be reused as the parity oracle).
- Effort: L

### XCUT-8: AABB / bounds: 5 types and ~40 hand-rolled min/max folds with different sentinels and NaN behaviour
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - types: rust/clash/src/aabb.rs:19 `Aabb {min,max}` (+Plato `Box3`), rust/geometry/src/kernel/broadphase.rs:36 `type Aabb = ([f64;3],[f64;3])`, rust/core/src/model_bounds.rs:16 `ModelBounds` (six named fields, init `f64::MAX/MIN`), rust/processing/src/types/mesh.rs `local_bounds: Option<[f32;6]>`, rust/geometry/src/geom_bounds.rs (`min/max` accumulators, `world_aabb() -> Option<[f64;6]>`), rust/geometry/src/router/diagnostics.rs:91 `HostBbox`
  - folds: rust/geometry/src/kernel/broadphase.rs:38 `tri_aabb`, :116 `tris_aabb`; rust/geometry/src/zone_split.rs:324 `tris_aabb` (verbatim copy of broadphase's); rust/geometry/src/router/frame_parts.rs:78 `mesh_bounds` [f32;6] + :96 `union_bounds`; rust/geometry/src/mesh.rs:646 `Mesh::bounds` (init `f32::MAX/MIN`, returns origin for empty); rust/geometry/src/router/voids/malformed_opening_repair.rs:308 `world_host_bounds`; rust/geometry/src/router/voids/coaxial_union.rs:529 `aabb_overlap`; rust/geometry/src/simplify/boxify.rs:17; rust/geometry/src/scan_outline/topology.rs:345 `bbox` [f64;4]; rust/geometry/src/triangulation/ring_geom.rs:10 `ring_bbox`; rust/processing/src/pdf_vector/extent.rs:57 `bbox`; rust/clash/src/aabb.rs:53 `from_positions`, bvh.rs:178 `compute_bounds`, tri_mesh.rs:369 `tri_bounds`, narrow.rs (4 folds); rust/export/src/gltf.rs (6 `f32::INFINITY` folds), collada.rs (2); apps/server/src/services/parquet_instancing.rs; rust/wasm-bindings/src/zero_copy/frame_swap.rs:25 (Y-up swap of a box)
- What: Sentinels differ (`INFINITY/NEG_INFINITY` vs `MAX/MIN` vs `origin`); NaN policy differs (`f64::min` skips NaN silently — geom_bounds.rs:34-60 has a 30-line comment explaining the per-axis well-formedness check that no other fold performs); empty-mesh result differs (`(origin, origin)` vs inverted infinities vs `None`).
- Why it matters: `Mesh::bounds()` on an empty mesh returns a zero-size box at the origin, which looks like a valid box to `union_bounds`; `ModelBounds::new()` with `f64::MAX` passes an `is_finite()` check. The careful NaN reasoning in geom_bounds.rs is not reused by the 39 other folds.
- Fix: `Aabb3<T: Float>` in the shared math module (XCUT-3) with `EMPTY`, `extend`, `from_positions(&[T])`, `union`, `overlaps`, `is_well_formed`, `to_array6`, `swap_zup_to_yup`; `Mesh::bounds() -> Option<Aabb3<f32>>`.
- Effort: M

### XCUT-9: Hashing: five FNV-1a implementations, five generated CRC32s, three content-hash algorithms, two `sha2` majors, and `DefaultHasher` in a persisted key
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED (LIKELY for the DefaultHasher stability consequence)
- Where:
  - FNV-1a: rust/wasm-bindings/src/api/gpu_meshes/source_fingerprint.rs:6 (32-bit), rust/export/src/usd/emit.rs:337 (64-bit), rust/processing/src/determinism.rs:147-166 (64-bit, three typed feeders), rust/processing/examples/perf_probe/fingerprint.rs:14 (64-bit `Fnv` struct), rust/export/src/merged/guid.rs:25 (32-bit variant inside `deterministic_global_id`), rust/processing/tests/module_size_ratchet.rs:495
  - CRC32: `fn crc32_hash` generated five times — rust/core/src/generated/{schema.rs:16771, ifc2x3/schema.rs:6850, ifc4/schema.rs:8174, ifc4x1/schema.rs:8438, ifc4x2/schema.rs:8586}
  - content hashes: rust/geometry/src/router/caching.rs:20 `compute_mesh_hash` (FxHasher, 128-sample), :82 `compute_mesh_hash_full` (u128); rust/export/src/gltf.rs:491 `geom_color_key` (xxh3_128 via `twox-hash`); apps/server/src/services/parquet_instancing.rs:40/50 `hash_u32_slice`/`hash_f32_slice` (**`std::collections::hash_map::DefaultHasher`**), duplicated verbatim in apps/server/benches/serialization.rs:287-301; rust/geometry/src/geom_hash.rs (custom quantised fold, `mix64`); rust/processing/src/appearance/evaluated_mask.rs:57 `fingerprint`, transfer.rs:185 `digest` (sha2 0.10); apps/server `sha2` 0.11 + `hex` for file digests
  - Cargo.lock: `sha2 0.10.9` (processing, cacache) and `sha2 0.11.0` (server) → `digest`, `block-buffer`, `crypto-common`, `cpufeatures` each compiled twice into the server binary
- What: `export/src/usd/emit.rs:333` correctly notes that `DefaultHasher` "is NOT guaranteed stable across Rust releases or targets"; `apps/server/src/services/parquet_instancing.rs:40` uses exactly that for the mesh-dedup grouping key of the `/optimized` Parquet route.
- Why it matters: Dedup grouping (which occurrences share a mesh row) can change between server builds on a toolchain bump, so the same IFC yields byte-different cached Parquet across deployments — the repo otherwise invests heavily in byte determinism. Five FNV copies will not stay identical (the wasm one already masks to 32 bits).
- Fix: `ifc_lite_core::hash::{Fnv1a64, fnv1a64(bytes)}` used by export/processing/wasm/tests; one `ContentHash` (xxh3_128, already a dep of export) for every dedup key including the server's; emit `crc32_hash` once from the generator; align `sha2` to one major via workspace deps.
- Effort: S–M

### XCUT-10: IFC GlobalId alphabet and validator duplicated with a drifted rule
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: alphabet — rust/export/src/merged/guid.rs:13 `GLOBAL_ID_CHARS`, rust/export/src/schema_convert.rs:227 `A` (identical literal), rust/processing/examples/schema_detection_bench_4661.rs:22. Validators — rust/export/src/merged/guid.rs:64 `is_global_id`, rust/export/src/rooted_type.rs:87 `is_global_id_shaped` (identical body), rust/processing/src/appearance/authored.rs:49 `valid_guid` (adds `first byte in '0'..='3'`). Leading-GUID extractors — rust/export/src/merged/guid.rs:94 `extract_global_id_fast`, :137 `leading_rooted_global_id`, :146 `read_leading_guid`, rust/export/src/rooted_type.rs:66 `extract_leading_guid` (the first and last are the same 20-line scan). Minters — merged/guid.rs:24 `deterministic_global_id`, schema_convert.rs:226 `placeholder_guid`.
- What: Only `authored.rs:49` enforces the spec constraint that the first character encodes 2 bits (`0..=3`); the two export validators accept `zzzzzzzzzzzzzzzzzzzzzz`.
- Why it matters: Merge reconciliation (`merged/guid.rs`) treats an invalid 22-char token as a GlobalId and may "unify" on it; the appearance writer rejects the same token. Two homes for the extractor means the rooted-type guard added for #3015 had to be applied twice.
- Fix: `ifc_lite_core::guid::{ALPHABET, is_valid, extract_leading(line) , deterministic(seed), placeholder(id)}`; export and processing import it.
- Effort: S

### XCUT-11: Colour keys and 8-bit quantisation re-implemented outside the sanctioned `Rgba` home
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `color_key` ×4 — rust/export/src/collada.rs:27 and rust/export/src/gltf.rs:444 (unclamped `(v*100).round() as i32`), rust/export/src/usd/fmt.rs:14 (finite-guarded, clamped 0..=100), rust/processing/src/geometry_export.rs:280 (bit-exact `to_bits` with signed-zero fold). `color_to_byte` — apps/server/src/services/parquet_optimized.rs:48 and apps/server/benches/serialization.rs:311, re-implementing rust/processing/src/style/mod.rs:136 `Rgba::to_rgba8` whose doc says "This is the *only* sanctioned quantization point (plan §8.3); the backend never calls it". `hex_val` ×2 — rust/core/src/step_encoding.rs:199 and rust/geometry/src/processors/texture/raster.rs:36 (jscpd clone). `srgb_to_linear` has one home (rust/export/src/color_space.rs:22) — good.
- What: glTF/COLLADA and USD disagree on how an out-of-gamut or NaN IFC colour is bucketed into a material (NaN → `0` via saturating cast in gltf vs explicit `0.0` in usd; `1.2` → 120 vs 100).
- Why it matters: Same model exports with N materials in GLB and N-1 in USDA; the "only sanctioned quantization point" claim in processing is already untrue.
- Fix: `Rgba::{key_2dp(), key_bits()}` in processing::style next to `to_rgba8`; server and export call them. Move `hex_val`/`hex_decode` to core (`step_encoding` already owns one) and have the texture decoder import it.
- Effort: S

### XCUT-12: Tolerances: 111 named constants and ~1,000 inline epsilon literals with the same concept at different values
- Category: DRY / Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where (non-test literal counts): `1e-9`/`1.0e-9` 303, `1e-6`/`1.0e-6` 267, `1e-12` 176, `1e-3` 108, `1e-4` 60, `1e-10` 55, `1e-7` 26, `1e-8` 17, `f64::EPSILON` 30. Named constants (full list in `/tmp/xcut/eps.txt`, 111 rows) — same concept, different homes/values:
  - generic `EPS`/`EPSILON` = 1e-9: rust/landxml/src/plan/numeric.rs:18, plan/numeric/parcel_measure.rs:11, alignment/numeric.rs:16 (three copies in one crate), rust/geometry/src/space_dcel/mod.rs:223, router/layers.rs:536, router/voids/geom.rs:450; = 5e-5 router/voids/sweep.rs:233; = 1e-6 router/voids/aabb_clip.rs:71
  - parallel test: rust/geometry/src/geom2d.rs:22 `PARALLEL_EPS` 1e-9, rust/geometry/src/processors/structural_edge.rs:32 `PARALLEL_EPSILON` 1e-9
  - plane coincidence: rust/geometry/src/rect_fast.rs:165 `PLANE_TOL` 1e-4 vs rust/geometry/src/router/voids/geom.rs:745 `PLANE_TOL` 1e-3
  - identity: rust/geometry/src/router/layers.rs:536 (1e-9) vs rust/processing/src/mesh_frame.rs:22 `PLACEMENT_IDENTITY_EPSILON` (1e-9) — same value, two implementations
  - chord deviation: `CHORD_TOL_M` 5e-4 declared twice (rust/geometry/src/profiles/directrix.rs:265, profiles/curves_2d.rs:143)
  - normalise guard: see XCUT-3 (six values); affine singular: 1e-18 vs 1e-24 (XCUT-4)
  - engulf: `ENGULF_TOLERANCE` and `ENGULF_TOLERANCE_F32` 0.03 pair (rust/geometry/src/router/voids/mod.rs:67-68)
  - unit-scale compatibility: rust/export/src/merged/units.rs:35 1e-6
  - tag merge: `TAG_REL_EPS`/`TAG_TOL_FLOOR` declared twice in rust/geometry/src/csg/consolidate/plane_merge.rs:75-76 and :170-171
- What: Numeric policy is per-function. The workspace lint block forbids clippy from touching numeric literals (good), but nothing names them.
- Why it matters: "Is this plane the same plane" is answered with 0.1 mm in rect_fast and 1 mm in voids/geom for the same metres-scaled meshes; the two `CHORD_TOL_M` can diverge silently.
- Fix: `ifc_lite_geometry::tol` with documented, grouped constants (`NORMALIZE_EPS`, `PARALLEL_SIN_EPS`, `IDENTITY_EPS`, `SINGULAR_DET_EPS`, `PLANE_COINCIDENCE_M`, `CHORD_TOL_M`, `UNIT_SCALE_REL_EPS`); replace the named duplicates first (mechanical), then ratchet the inline literal count with a test like `module_size_ratchet`.
- Effort: M

### XCUT-13: Number/identifier/string formatting helpers duplicated across export and server
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/export/src/model_props.rs:20 `fmt_num` ≡ apps/server/src/services/data_model/property_value.rs:304 `fmt_number` (identical); rust/export/src/usd/fmt.rs:98 `fmt_f64` (non-finite → "0"); rust/export/src/step_log/jsval.rs:109 `format_step_real`/:126 `to_step_real` (JS parity, legitimately distinct). Identifier sanitisers with three different character classes: rust/export/src/lib.rs:164 `sanitize_identifier` (alnum/`_`/`-`), rust/export/src/constructions.rs:43 `sanitize` (alnum only), rust/export/src/usd/fmt.rs:49 `sanitize_ident` (ASCII alnum/`_` + legal start). Escapers are correctly single-homed per target format (step_text.rs:71, xml_text.rs:10, csv_cell.rs:203, usd/fmt.rs:70) — keep.
- Fix: `fmt_num` to core (next to the float parser it inverts) and import in server; one `sanitize_ident(s, allowed: CharClass, fallback)` in export.
- Effort: S

### XCUT-14: Four cancellation/progress mechanisms
- Category: DRY / Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/progress.rs:28 process-global `OnceLock<fn()>` hook + `tick()/tick_strided()` (installed by rust/wasm-bindings/src/progress_hook.rs:50); rust/processing/src/processor/mod.rs:191 `ProcessingOptions.cancel: Option<Arc<AtomicBool>>` (set by apps/server/src/services/streaming.rs:111); rust/landxml/src/limits.rs:8 `trait LandXmlCancellation` + `LandXmlCancellationFlag` + rust/landxml/src/xml.rs:22 `CancellationPoller`; rust/geometry/src/{cdt.rs, terrain_cdt.rs, cdt/insertion.rs} and rust/landxml/src/{terrain_topology, terrain_filter, terrain_validation}.rs thread `progress: &mut dyn FnMut() -> Result<(), TerrainCdtError>` through 23 signatures; apps/server/src/routes/parse/stream_progress.rs:31 `StreamProgress(Recorder)`; budgets: rust/processing/src/appearance/{budget,transfer_budget}.rs, rust/processing/src/pdf_vector/fills.rs:19, rust/geometry/src/analytic/profile_topology.rs:15, rust/export/src/quantity_analysis_budget.rs:30, rust/landxml/src/plan/numeric/parcel_probe.rs:18 (six `Budget` structs).
- What: A geometry worker cannot be cancelled (only heart-beaten), a processing job can be cancelled but not heart-beaten, LandXML has both via a trait, and the CDT threads a closure by hand through every recursion level.
- Why it matters: The wasm worker-recovery story (progress.rs doc) and the server disconnect story (streaming.rs) solve the same problem with incompatible plumbing; adding cancellation to CSG means a fourth mechanism.
- Fix: `ifc_lite_core::work::{WorkObserver: is_cancelled() + tick(), Budget}` as an `Arc<dyn WorkObserver>` (or `&dyn`) carried in `ProcessingOptions`, `GeometryRouter` and `LandXmlLimits`; geometry's `progress::tick()` becomes a thin forwarder; the CDT takes `&dyn WorkObserver` instead of `&mut dyn FnMut`.
- Effort: M

### XCUT-15: Seven error-handling policies across the workspace
- Category: Best-practice / Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where / numbers (non-test):
  - rust/core/src/error.rs:12 `thiserror` enum, 6 variants — consistent
  - rust/geometry/src/error.rs:12 `thiserror` enum, but `Error::geometry(String)` called **451×** and 42 `Result<_, String>` signatures (rust/geometry/src/contour_composition.rs:28, analytic/profile_topology.rs:24, scan_outline/mod.rs:120 are `pub`)
  - rust/processing: **171** `Result<_, String>` (26 of them `pub fn`), 3 `Box<dyn Error>`, no error type at all
  - rust/export/src/error.rs:13 `ExportError` with a hand-written `Display`; 45 `Result<_, String>`; six more bespoke error structs with manual `Display`/`Error` impls (rebar_fabrication.rs:56/70, rebar_preflight.rs:50/62, schema_unrepresented.rs:45, landxml_terrain.rs:153)
  - rust/landxml/src/model.rs:42 `LandXmlError {code, message}` (manual impls) + **41** `Box<dyn Error>` + 16 `Result<_, String>` + 77 `expect()`
  - rust/cloud-import/src/lib.rs:10 `pub type Result<T> = Result<T, String>`
  - rust/wasm-bindings: 61 `Result<_, JsValue>`, 49 `JsValue::from_str(&…)`, 36 `JsError::new(…)`, 25 `Result<_, String>`; `thiserror` declared but unused
  - apps/server/src/error.rs:17 `ApiError` (thiserror) with 49 `ApiError::X(String)` wraps and 18 `map_err(|e| ApiError::…)` closures; `anyhow` only in main.rs
- What: Errors lose their type at every crate boundary (`.map_err(|e| e.to_string())` is the standard crossing), so callers match on message text or cannot distinguish "untrusted input rejected" from "internal invariant broken". `Error::geometry(msg)` means the typed enum carries no information beyond the string.
- Why it matters: The server maps everything to `Processing(String)`/HTTP 500; a budget exhaustion, a malformed file and a kernel bug look identical to clients and to the on-call log reader; the wasm layer has three different ways to raise the same condition.
- Fix (one policy): every library crate owns one `thiserror` enum with a small, stable `kind()` (`Malformed`, `Unsupported`, `Limit`, `Internal`) and `#[from]` on the crate below; `Result<_, String>` is banned in `pub` signatures (clippy `result_large_err` is not the tool — add a `rg`-based test like `module_size_ratchet` that ratchets the count down); wasm converts once via `impl From<ProcessingError> for JsError`; server maps `kind()` to status codes in one `impl From<_> for ApiError`. Keep `anyhow` to binaries.
- Effort: L

### XCUT-16: No external dependency uses workspace inheritance; `sha2` is already split across majors
- Category: Best-practice
- Severity: Medium
- Confidence: CONFIRMED
- Where: Cargo.toml:14-20 `[workspace.dependencies]` lists only `ifc-lite-*`. Per-crate declarations: `nalgebra = "0.35"` in rust/geometry, rust/processing, rust/export, rust/cloud-import; `serde` in 7 crates, `serde_json` in 9, `rayon` in 5, `rustc-hash` in 5, `memchr` in 4, `thiserror` in 4, `png` in 2, `tracing` in 3, `zip = "8"` in 2, `arrow`/`parquet = "60"` in 2 (with a comment "pinned to the server's 60"). `sha2 = "0.10"` (rust/processing/Cargo.toml:528) vs `sha2 = "0.11"` (apps/server/Cargo.toml:723). Internal deps use three styles: `ifc-lite-core.workspace = true` (geometry, landxml), `{ version = "20.4.0", path = ".." }` (processing, wasm-bindings, ffi — ffi explains it for publish, but workspace deps already carry the version), `{ path = ".." }` (server, python). rust/wasm-bindings/Cargo.toml:581 `license = "MPL-2.0"` literal instead of `license.workspace = true`. rust/python and rust/csg-thread-bench carry no `[lints]` block at all, so the numeric-safety policy does not apply to them.
- Why it matters: A version bump is 4–9 edits; `rustc-hash` carries a comment "must match ifc-lite-geometry version" because nothing enforces it; the sha2 split compiles two digest stacks into the server.
- Fix: Move every external dep to `[workspace.dependencies]` with `workspace = true` everywhere (`cargo autoinherit` does this mechanically); align sha2; add `[lints] workspace = true` to python and the bench crate.
- Effort: S

### XCUT-17: Seven declared dependencies are never referenced
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED (identifier never appears in the crate's sources)
- Where: rust/core/Cargo.toml:115 `smallvec`; rust/geometry/Cargo.toml:364 `memchr`; rust/wasm-bindings/Cargo.toml:616 `futures-util`, :643 `memchr`, :646 `thiserror`, :648 `wasm-bindgen-futures`; apps/server/Cargo.toml:715 `tokio-stream`. (`rayon-core` in wasm-bindings is feature-only and documented — keep.)
- Why it matters: Each is compile time and supply-chain surface for nothing; `wasm-bindgen-futures` is pinned with `=` and will block upgrades.
- Fix: Delete; add `cargo udeps`/`cargo machete` to the CI lint lane.
- Effort: S

### XCUT-18: 19 crates resolved at multiple versions in Cargo.lock; the python lockfile has drifted from the root one
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: Cargo.lock — `sha2` 0.10.9/0.11.0 (direct, see XCUT-16), `thiserror` 1.0.69 (via cacache/miette/ssri, server) / 2.0.21, `base64` 0.21.7 (ssri) / 0.23.1 (server, arrow), `num-bigint` 0.4.6 (num-rational, geometry) / 0.5.1 (arrow), `itertools` 0.13 (criterion) / 0.14 (earcutr), `miniz_oxide` 0.8.9 (png) / 0.9.1 (flate2, zip), `hashbrown` 0.15/0.17, `getrandom` ×3, `syn` 2/3, `glam` ×4 (0.30–0.33, all optional conversion deps of nalgebra 0.35 — resolved but not compiled), `async-channel`/`event-listener` (async-std via criterion). rust/python/Cargo.lock disagrees with the root lock on 33 packages (`sha2 0.10.9` vs `0.11.0`, `syn 2.0.118` vs `3.0.2`, `serde 1.0.228` vs `.229`, …).
- Why it matters: Two lockfiles for one source tree means the wheel and the server ship different transitive code for the same `ifc-lite-geometry`; AGENTS.md says "Cargo.lock is committed (app crates need reproducibility)" — that guarantee does not extend to the wheel.
- Fix: Align the direct ones (sha2) and let the rest follow; consider making `rust/python` a workspace member with `default-members` excluding it (the `[workspace]` override comment in rust/python/Cargo.toml:554 is about worktree discovery, which `default-members` also solves), so one lockfile covers both.
- Effort: S

### XCUT-19: Crate layering: copies made to avoid dependencies, and a landxml concern living in geometry
- Category: DRY / Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - clash ↔ geometry: rust/clash/src/obb_detect.rs:27 `canonical` ≡ rust/geometry/src/clash_contact_axes.rs:37 (jscpd) and `normalize` twins, because `ifc-lite-clash` "has zero dependencies and does not depend on this crate" (rust/geometry/Cargo.toml:409); geometry dev-depends on clash.
  - geometry internal, explicitly: rust/geometry/src/profile_extractor.rs:505 "Duplicated from router/transforms.rs (pub(super) there) to avoid coupling." — `get_placement_recursive` (profile_extractor.rs:525) vs rust/geometry/src/router/transforms/walk.rs:65 `get_placement_transform_with_depth`.
  - wasm ↔ landxml: rust/wasm-bindings/src/api/landxml/endpoints.rs:237-257 re-derives the resolver work limit that rust/landxml/src/stream/derived/plan.rs:243 `plan_resolution_work_limit` computes (jscpd 21 lines) instead of landxml exporting it.
  - server ↔ export: see XCUT-7 (no dependency edge → re-implementation).
  - landxml → geometry inversion: the terrain CDT (rust/geometry/src/cdt.rs 1,516 lines, cdt/insertion.rs, terrain_cdt.rs, and `TerrainCdtError` at rust/geometry/src/terrain_cdt.rs:18) exists only to serve LandXML terrain ingestion, yet lives in the IFC geometry crate; `ifc-lite-landxml` depends on `ifc-lite-geometry` for it and nothing else IFC-related, and also pulls `geometry-predicates` directly (rust/landxml/Cargo.toml:472) alongside geometry's copy.
  - csg-thread-bench ↔ processing example: rust/csg-thread-bench/src/lib.rs:35-48 ≡ rust/processing/examples/csg_scaling_bench.rs:38-51 (corpus replay loop).
- Why it matters: Every one of these is a seam where a fix lands once; the clash/geometry clone already carries an "identical to the TS canonical" comment on one side only.
- Fix: a zero-dep `ifc-lite-math` crate (XCUT-3) that clash *can* depend on; move `cdt.rs`/`terrain_cdt.rs` into landxml (or a `terrain` crate) so geometry stops owning a LandXML error type; export `plan_resolution_work_limit` from landxml; make `profile_extractor` call the router walk.
- Effort: M

### XCUT-20: Feature-flag and env-var configuration sprawl without a catalogue
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where: Cargo features — geometry: `opening-perf-trace`, `debug_geometry`, `csg_capture`, `observability`, `triangulation-alt`, `test-support`, `csg_topology_gate`, `csg_manifold_gate`; processing: `opening-perf-trace`, `csg-capture` (hyphen, forwards to `csg_capture`), `observability`, `phase-markers`; wasm: `debug_geometry`, `threads`, `console-tracing`, `console_error_panic_hook`; export: `parquet-bos`, `observability`; ffi/server: `mimalloc`. `cfg(feature)` sites: `opening-perf-trace` 78, `csg_manifold_gate` 41, `csg_topology_gate` 39, `debug_geometry` 19 — i.e. ~180 cfg forks in production code for diagnostics that ship off. Env vars read in non-test code (33 distinct): `IFC_LITE_{PRISM_CUT, VOID_UNION, RECT_PARAM, RECT_FAST, LOCAL_FRAME, HALFSPACE_CAP_OFF, FAST_CUT_RATIO, DISABLE_DEGENERATE_BACKSTOP, DEDUP_EXTRA, CSG_BUDGET, CSG_ELEMENT_BUDGET, GLB_STREAM_THRESHOLD_MB, REQUIRE_FIXTURES}`, `IFCLT_{MODEL, COLUMNAR, BUDGET}`, `IFC_MEM_BUDGET_MB`, `IFCLITE_TRIANGULATION_ALT`, … cached in `OnceLock<bool>` statics at rust/geometry/src/{rect_fast.rs:66,92, router/mod.rs:380, router/transforms/mod.rs:62, router/voids/bool2d_path.rs:58, coaxial_union.rs:90, prism_cut.rs:89, kernel/budget.rs:130,138, processors/boolean/cut_heuristics.rs:58}, rust/processing/src/element_degenerate.rs:39. Process-global overrides: rust/geometry/src/router/transforms/mod.rs:27 `LOCAL_FRAME_OVERRIDE: AtomicI8`, rust/geometry/src/triangulation/alt_oracle.rs:23, csg_capture.rs:45, kernel/budget.rs:100-110, rust/wasm-bindings/src/api/mod.rs:129/212/231.
- What: Runtime behaviour of the mesher depends on 13+ undocumented env vars, read once per process; native defaults differ from wasm defaults (`local_frame_enabled`: wasm ON, native OFF). Feature names mix `snake_case` and `kebab-case` for the same concept across crates.
- Why it matters: "Why does my CLI output differ from the viewer" has at least 13 env-shaped answers that no AGENTS.md lists; test isolation for `OnceLock` statics is impossible (several tests take a `Mutex` just to serialise them, e.g. rust/processing/tests/issue_4103_shared_map_buffer_identity.rs:177).
- Fix: One `GeometryConfig` struct built once (env → struct in the binary, explicit in tests) and passed to `GeometryRouter::with_config`; delete the `OnceLock` readers; a `docs/architecture/runtime-flags.md` generated from that struct; normalise feature names to kebab-case.
- Effort: M

### XCUT-21: God files and god functions, frozen by a 461-row size allowlist
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where (non-generated, non-test, lines): rust/geometry/src/router/voids/prism_cut.rs 3116; rust/export/src/gltf.rs 3090; rust/geometry/src/router/voids/mod.rs 1866; rust/processing/src/processor/mod.rs 1656; rust/geometry/src/cdt.rs 1516; rust/geometry/src/space_dcel/mod.rs 1267; rust/geometry/src/router/processing.rs 1170; rust/geometry/src/alignment.rs 1080; rust/wasm-bindings/src/api/mod.rs 1034; rust/wasm-bindings/src/api/gpu_meshes/batch.rs 970; rust/geometry/src/mesh.rs 947; rust/geometry/src/kernel/retriangulate.rs 935; rust/geometry/src/processors/boolean/mod.rs 924; rust/geometry/src/facet_weld.rs 923; rust/geometry/src/csg/consolidate.rs 911; … (5 files >1500, 9 >1000; `rust/processing/tests/module_size_allowlist.txt` has 461 rows, top budgets 4028/3160/2058). Functions ≥200 lines (54 hand-written; generated excluded): rust/geometry/src/router/voids/mod.rs:1000 `apply_void_context_inner` 781; rust/export/src/gltf.rs:2139 `plan_bounded_glb` 634; rust/wasm-bindings/src/api/gpu_meshes/batch.rs:71 `produce_batch` 579; rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:185 `pre_pass_streaming_impl` 562; rust/landxml/src/terrain.rs:25 `adapt_faceless_tin` 376; rust/export/src/gltf.rs:1119 `build_gltf` 373; rust/geometry/src/csg/consolidate.rs:143 365; apps/server/src/routes/parse/parquet_stream.rs:51 342; rust/geometry/src/facet_weld.rs:579 341, :150 332; rust/processing/src/analytic_export/walk.rs:65 331; rust/export/src/model.rs:138 327; rust/clash/src/narrow.rs:60 324; apps/server/src/services/parquet_optimized.rs:86 314; rust/processing/src/symbolic/items.rs:28 312; rust/geometry/src/router/voids/prism_cut.rs:2805 311; … (geometry 19, core 9 generated, server 7, export 7, landxml 4, processing 4, wasm 3, clash 1).
- Why it matters: The ratchet stops growth but 461 exemptions means the "~400-line rule" in AGENTS.md is aspirational; the largest functions are exactly the paths (void cutting, GLB planning, wasm batch) where the DRY findings above live.
- Fix: Target the top 10 functions, not the top files: split `apply_void_context_inner` by opening class, `plan_bounded_glb`/`build_gltf` into pass structs, `produce_batch`/`pre_pass_streaming_impl` into stage fns. Add a function-length ratchet (the `/tmp/xcut/longfn.py` heuristic is enough) next to the module ratchet.
- Effort: L

### XCUT-22: Test sprawl: 240 integration-test binaries and the same helpers copied dozens of times
- Category: DRY / Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/tests has 136 `.rs` files (71 named `issue_*`), rust/processing/tests 106 — each file is a separate test crate (link time scales linearly; `cargo test --workspace` builds ~260 binaries). jscpd: 215 clones in geometry, 42 in processing, 25 in export, 22 in landxml, mostly test fixtures (e.g. `issue_3353_vid_census_tests.rs:309-353` cloned into 6 files; `voids_common/fixtures.rs` cloned into `material_layers_test.rs` and `synthesis_tests.rs`). Helpers re-defined: `mesh_volume`/`signed_volume` 20 test copies (rust/geometry/tests/{engulfing_solid_void.rs:75, issue_098_v5c.rs:47, csg_property_test.rs:95, rect_param_parity.rs:28, halfspace_clip_cap_regression.rs:91, …}, rust/processing/tests/common/wall_frame_seams.rs:112, …) while `ifc_lite_geometry::kernel::mesh_volume` is `pub`; `fixture()` ×11, `box_mesh` ×5, `mesh_of` ×5, `signed_volume` ×4, `cube`/`square`/`wall` ×3; `fn dot/cross/norm` re-typed in 6 test files; the "skip when fixture absent, point to `pnpm fixtures`" boilerplate appears 185 times in 87 files; `CARGO_MANIFEST_DIR` path joins 75 times. Cross-crate test clones: rust/export/tests/issue_4118_site_rotation_instancing.rs:27-99 ≡ rust/processing/tests/site_local_instancing.rs:31-102 (73 lines), apps/server/src/routes/parse/finish_tests.rs:22-40 ≡ rust/processing/tests/issue_957_type_only_geometry.rs:24-42, rust/geometry/tests/ifc4x3_sectioned_linear_positions.rs:37-58 ≡ rust/wasm-bindings/src/api/alignment_lines_tests.rs:66-87.
- Fix: An `ifc-lite-testkit` dev-only crate (fixture resolution + skip, `require_fixtures`, wall/box/opening IFC builders, `mesh_volume`, `signed_volume`, `open_edges`, FNV fingerprint) consumed by every crate's tests; fold `issue_*` files into a handful of `tests/voids/*.rs` modules under one `tests/voids.rs` harness per topic.
- Effort: M

### XCUT-23: Hygiene numbers (unsafe, unwrap/expect, allows, TODOs)
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where / numbers (non-test):
  - `unsafe`: ffi 14 (3 `pub unsafe extern "C"` with `# Safety` docs, 4 SAFETY comments), core 3 (1 SAFETY: rust/core/src/parser/scanner.rs:296 `from_utf8_unchecked`), python 2 (rust/python/src/lib.rs:154/160 `slice::from_raw_parts` reinterpreting `Vec<[f64;3]>`/`Vec<[u32;3]>` as bytes — **no SAFETY comment**; sound on LE targets, relies on array layout), geometry/processing/export/wasm/server 0 real sites (the counts of 14/1/1/1 are the word "unsafe" in prose). No crate declares `#![forbid(unsafe_code)]` although 8 of 11 could.
  - `unwrap()`+`expect()` per kLOC: landxml **4.79** (77 `expect`, e.g. rust/landxml/src/parser.rs:138,143,323,331, pipe_parser.rs:170-298 "guarded above"), python 3.13, export 1.04, core 0.97, server 0.83, geometry 0.80, processing 0.75, clash 0.40, wasm 0.00. `panic!/unreachable!`: landxml 18 (rust/landxml/src/terrain.rs:210-364 ×7 `unreachable!("terrain work callback only charges or stops")`), geometry 10, export 9.
  - `#[allow]` by lint (non-test, non-generated): `clippy::too_many_arguments` 70 (wasm 28, geometry 12 — although geometry already allows it crate-wide in Cargo.toml:447, processing 11, export 9, clash 5), `dead_code` 27, `non_snake_case` 8, `type_complexity` 8, `needless_range_loop` 8, `unused_imports` 5, `should_implement_trait` 5. `dead_code` without a "why" (root AGENTS.md line 102 requires one): apps/server/src/services/cache.rs:122,129; rust/geometry/src/processors/brep/faceted.rs:35; rust/geometry/src/router/diagnostics_recording.rs:131,157,176.
  - TODO/FIXME/HACK/XXX: 5 total (rust/landxml/src/stream/lifecycle.rs:34 `TODO(remove-by: #5050)`, rust/clash/src/tri_mesh.rs:230, rust/geometry/src/space_dcel/{mod.rs:49, arrangement.rs:275} "robustness TODO" — naive f64 arrangement, the only alarming one).
  - `eprintln!` in geometry: 28 sites, all inside `diag_warn!/diag_debug!` `else` legs or `#[cfg(debug_assertions|test)]` — compliant with rust/AGENTS.md.
- Fix: `#![forbid(unsafe_code)]` on geometry, processing, export, clash, landxml, cloud-import, wasm, server; SAFETY comment in rust/python/src/lib.rs:154; move landxml's `expect("guarded above")` pattern to `let … else { return Err(internal(..)) }`; drop the 12 redundant geometry `too_many_arguments` allows; add the missing `dead_code` justifications.
- Effort: S

### XCUT-24: Docs-vs-code drift (AGENTS.md / rust/AGENTS.md)
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where / what:
  - rust/AGENTS.md "core/processing/clash/ffi/export/wasm-bindings use `[lints] workspace = true`" — landxml, cloud-import and apps/server do too; rust/python and rust/csg-thread-bench have **no** `[lints]` (the numeric-safety policy does not reach them).
  - rust/AGENTS.md "`csg_capture` and `debug_geometry` are the other opt-in features" — geometry now has 9 features (rust/geometry/Cargo.toml:281-340), four of which are documented only in Cargo.toml comments.
  - rust/AGENTS.md "Kernel boolean entry points are `subtract` / `subtract_many` / `union` / `union_many` / `intersection` (`geometry/src/kernel/mesh_bridge.rs`)" — `union_many` lives in rust/geometry/src/kernel/nary_union.rs:19.
  - root AGENTS.md line 61 "Manifold C++ and the BSP port are deleted… there is no kernel selection" — the user-facing diagnostic at rust/geometry/src/diagnostics.rs:229 still renders "solid-vs-solid IfcBooleanResult.DIFFERENCE skipped (BSP unsafe)".
  - root AGENTS.md line 102 "Intentionally-unused Rust items need `#[allow(dead_code)]` and a why" — violated at the six sites in XCUT-23.
  - root AGENTS.md line 42 "The ~400-line rule is enforced" — enforced as a ratchet with 461 exemptions (rust/processing/tests/module_size_allowlist.txt); worth saying so.
  - root AGENTS.md line 65 lists the colour single homes but not that `Rgba::to_rgba8` is bypassed by the server (XCUT-11); line 6 "Rust crates … source of truth for the server" is untrue for the data model (XCUT-7).
  - rust/AGENTS.md "determinism.yml stale cmake comment is dead; ignore it" — still present at .github/workflows/determinism.yml:48-49; delete it instead of documenting it.
  - processing/prepass.rs:353 "This is the only sanctioned place that hunts for IFCPROJECT" — contradicted by 11 other scanners (XCUT-6).
- Fix: Update the four sentences; delete the determinism.yml comment and the BSP string; add a "runtime flags" and "feature flags" table (XCUT-20).
- Effort: S

### XCUT-25: Server mesh-dedup keys use `std` `DefaultHasher`, which has no cross-release stability guarantee
- Category: Quirk
- Severity: Low
- Confidence: LIKELY
- Where: apps/server/src/services/parquet_instancing.rs:40 `hash_u32_slice`, :50 `hash_f32_slice` → `MeshGeometryKey` (:30) used to group occurrences for the `/optimized` Parquet instancing table.
- What: `DefaultHasher::new()` is SipHash-1-3 with zero keys today, but std documents that the algorithm may change; the repo's own export/usd/emit.rs:333 and processing/tests/module_size_ratchet.rs:55 avoid it for exactly that reason.
- Why it matters: Grouping is by equality of the 3-tuple, so correctness survives an algorithm change, but the *iteration/assignment order* of groups (hence mesh indices and bytes in the Parquet) can differ across toolchains, breaking the byte-determinism the server tests otherwise pin.
- Fix: Use the same xxh3_128 content key export already uses (XCUT-9).
- Effort: S

### XCUT-26: `read_conic_placement_3d` normalises a possibly-zero axis without a guard (NaN frame)
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED (by reading; every sibling parser guards this case)
- Where: rust/geometry/src/profiles/curves_3d.rs:102-109 (`Vector3::new(...).normalize()` on Axis), :128-134 (same on RefDirection), :148 (`z_axis.cross(&x_axis).normalize()`).
- What: `IFCDIRECTION((0.,0.,0.))` as the `Axis` or `RefDirection` of an `IfcCircle`/`IfcEllipse` `Position`, or a RefDirection parallel to Axis, yields `0/0 = NaN` components; the canonical reader (rust/geometry/src/transform.rs:78 `build_axis2_matrix`) handles both with `try_normalize(1e-9)` and a perpendicular fallback. The same function also defaults a missing third Axis coordinate to `1.0` (line 105) while every other reader uses `0.0`.
- Why it matters: Scenario: a swept-disk or revolved profile whose directrix circle was authored with a degenerate Axis (seen in Revit/Allplan exports) produces NaN sample points; downstream finiteness filters drop the whole curve (silent missing geometry) or, where no filter exists, NaN vertices reach the mesh.
- Fix: Delete this reader and call the shared `Axis2Placement` reader from XCUT-1 (`frame()` accessor).
- Effort: S

### XCUT-27: Placement-chain walk implemented nine times with two different depth limits
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/transforms/walk.rs:47/65 `get_placement_transform(_with_depth)` (canonical, `MAX_PLACEMENT_DEPTH`=100 from rust/core/src/limits.rs:74); rust/geometry/src/profile_extractor.rs:525 `get_placement_recursive` (100); rust/processing/src/symbolic/transform.rs:152 `resolve_placement_for_symbolic` (**`depth > 50`**); rust/processing/src/analytic_export/placement.rs:11 `validate_placement_chain` (100, visited-set); rust/processing/src/appearance/source.rs:99 `validate_world_placement` (100); rust/geometry/src/alignment_sampling_placement.rs:11 (100); rust/export/src/step_map_rigid.rs:193 `placement_root` (iterative, memoised, 100); rust/export/src/step_map_transform_preflight.rs:277 `placement` (100), step_map_rigid_contexts.rs:100; rust/export/src/landxml_terrain_georef.rs:83 (100); rust/export/src/step_log/extract.rs:188 (**literal `100`**); apps/server/src/services/data_model/spatial_elevation.rs:78 `extract_placement_elevation` (one level only, by design); rust/core/src/decoder/caches.rs:114-154 placement transform cache (used only by the router).
- What: Same traversal (PlacementRelTo → recurse, RelativePlacement → Axis2Placement) with cycle handling by depth counter in some, by `HashSet` in others; the 2D symbolic path truncates at 50 where the mesh path allows 100 (rust/core/src/limits.rs:181 pins "the documented 100").
- Why it matters: A model with a 60-deep placement chain (deep assemblies do this) renders its 3D geometry but drops its 2D symbols as "unresolved"; `profile_extractor` walks the chain again without the decoder's transform cache.
- Fix: One `ifc_lite_geometry::placement::resolve_chain(id, decoder, &mut cache) -> Result<Matrix4, PlacementError{Cyclic, TooDeep, Dangling}>` built on the core cache; 2D consumers project the 4×4.
- Effort: M

### XCUT-28: Polygon normal / area and signed-volume helpers duplicated across crates
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: normals — rust/geometry/src/triangulation.rs:482 `calculate_polygon_normal` (Newell), rust/geometry/src/processors/boolean/polygonal_prism.rs:69 `polygon_normal`, rust/geometry/src/processors/sectioned.rs:586 `compute_face_normal`, rust/geometry/src/kernel/coplanar.rs:28 `plane_normal` ≡ rust/geometry/src/kernel/tritri.rs:50 `plane_normal`, rust/geometry/src/clash_contact_axes.rs:123 `face_normal`, rust/export/src/geom.rs:47/61 `newell_raw`/`newell_normal`, rust/processing/src/scan_segmentation/prism.rs:116 `face_normal`. Areas — rust/geometry/src/bool2d.rs:201 `compute_signed_area`, rust/geometry/src/geom2d.rs:38 `polygon_area`, rust/export/src/geom.rs:68 `polygon_area`, rust/export/src/dfjson/plates.rs:128 `signed_area_2d`, rust/processing/src/pdf_vector/strokes.rs:165 `signed_area`, rust/geometry/src/space_dcel/mod.rs:1198. Volumes — rust/geometry/src/kernel/signed_volume.rs:56/64/82/119 (four variants), rust/geometry/src/kernel/mesh_volume.rs:74, rust/geometry/src/router/voids/geom.rs:331/360, rust/geometry/src/world_frame_fixture.rs:125.
- Fix: `v3::newell_normal`, `v2::signed_area`, `mesh::signed_volume(about)` in the shared math module; export's `geom.rs` becomes HBJSON-specific glue only.
- Effort: S

### XCUT-29: Vertex welding / quantisation grids differ per consumer
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/mesh_weld.rs:182/299 `weld_indexed`/`weld`, rust/geometry/src/mesh_position_weld.rs:18 `weld_impl`, rust/geometry/src/mesh.rs:723 `welded_by_position`, rust/geometry/src/facet_weld.rs:150, rust/geometry/src/csg/consolidate/ring_ops.rs:43 (2D); rust/processing/src/geometry_export.rs:287 `weld_positions` (own `1/eps` grid); apps/server/src/services/parquet_optimized.rs:42 `quantize_position` (0.1 mm) duplicated in apps/server/benches/serialization.rs:306; rust/export/src/collada.rs:40 vertex key (0.1 mm + 1e-3 normal).
- Fix: `Mesh::welded(grid: WeldGrid)` as the one implementation; exporters pick a `WeldGrid::MM_0_1` constant.
- Effort: S

### XCUT-30: Mesh container types: four wrappers around one `MeshData`
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/processing/src/types/mesh.rs:70 `MeshData` (source of truth), apps/server/src/types/mesh.rs:26 `MeshData` (`#[serde(flatten)]` wrapper adding finish; justified by semver in its doc), apps/server/benches/serialization.rs:25 `MeshData` (a third, bench-local copy), rust/wasm-bindings/src/zero_copy/mesh.rs:33 `MeshDataJs`, rust/export/src/mesh_input.rs:107 `MeshInput`, rust/clash/src/tri_mesh.rs:27 `TriMesh` (f64).
- Fix: Delete the bench copy (use the server type); the rest are transport adapters and acceptable once `MeshData` gets the finish fields at the next major.
- Effort: S

## Concept inventory

One line per definition; "→" marks the recommended single home.

**Vector/matrix math** (→ new zero-dep `ifc-lite-math` or `ifc_lite_core::math`)
- rust/clash/src/vec3.rs:16 `Vec3=[f64;3]` + sub/add/scale/cross/dot/dist_sq/mid/centroid; rust/clash/src/generated/plato.rs:157 `Vec3` struct, :Box3
- rust/clash/src/obb_detect.rs:16 `normalize`, :27 `canonical`
- rust/geometry/src/lib.rs:201 re-exports `nalgebra::{Matrix4, Point2, Point3, Vector2, Vector3}`
- rust/geometry/src/clash_contact_axes.rs:37 `canonical`, :52 `dot3`, :56 `cross3`, :81 `normalize3`, :123 `face_normal`
- rust/geometry/src/kernel/arrangement/classify.rs:17 `cross3`, :20 `dot3`; kernel/tritri.rs:46 `cross_f64`, :50 `plane_normal`; kernel/coplanar.rs:28 `plane_normal`; kernel/rational.rs:49/61; kernel/fixed.rs:69/72
- rust/geometry/src/router/voids/prism_cut.rs:218 `V3`, :222-265 dot/sub/add/scale/cross/norm/normalize/lerp
- rust/geometry/src/scalar.rs:114 `transform_point4`, :145 `transform_normals`; extrusion.rs:425 `apply_transform`; extrusion_generic.rs:387
- rust/geometry/src/router/transforms/mod.rs:100 `mat4_to_col_array`, :108 `mat4_to_row_major`; instancing/collate.rs:9 `IDENTITY16`, :17 `compose_world`, :28 `mat4_to_row_major_f32`; instancing/dont_bake.rs:21 `compose_instance_world_row_major`; router/processing.rs:21 `IDENTITY_ROW_MAJOR`; router/layers.rs:535 `matrix_is_identity`
- rust/geometry/src/triangulation.rs:482 `calculate_polygon_normal`; processors/boolean/polygonal_prism.rs:69; processors/sectioned.rs:494/515 `lerp_*`, :586 `compute_face_normal`; geom2d.rs:38 `polygon_area`; bool2d.rs:201 `compute_signed_area`; scan_outline/topology.rs:345 `bbox`, :358 sub/dot (2D)
- rust/processing/src/appearance/transfer_math.rs:7 `Point`, :8-19 sub/dot/cross, :27 `normal`; authored.rs:18/21; calibration.rs:36/39; mapping.rs:31/34; scan_proposals/frame.rs:14-25 add/scale/norm/unit, :43 `Similarity::from_row_major`; scan_segmentation/ring.rs:81 `dot2`, :89 `length2`; pdf_vector/strokes.rs:23/26, :165 `signed_area`; pdf_vector/flatten.rs:14 `distance`
- rust/processing/src/simplify_math.rs:44 `matmul_row_major`, :60 `transform_point_row_major`, :70 `invert_affine_row_major`, :103 `averaged_vertex_normals`
- rust/export/src/gltf/matrix.rs:33/40/46 `S_YUP`/`S_YUP_INV`/`IDENTITY16`, :54 `mat4_mul`, :137 `mat4_translation`, :143 `row_major_f64_to_col_major_f32`, :155 `affine_inverse`, :198 `compose_world_meta`; export/src/geom.rs:17 `xf`, :26 `dist`, :47/61 `newell_*`, :68 `polygon_area`, :231 `dot`; export/src/openings.rs:18 `sub`, :19 `norm`; export/src/dfjson/plates.rs:128 `signed_area_2d`
- rust/wasm-bindings/src/zero_copy/frame_swap.rs:48 `matmul`; api/alignment_lines.rs:125 `IDENTITY`
- apps/server/src/services/parquet_instancing.rs:125 `apply_r_t`, :216 `P_ZUP_TO_YUP(_T)`, :219 `mat3_mul`, :280 `IDENTITY_ROTATION`

**Transforms / placements** (→ `ifc_lite_geometry::transform::{Axis2Placement, placement::resolve_chain}`)
- Axis2Placement3D readers: rust/geometry/src/transform.rs:26, :233; processors/helpers.rs:31; profile_extractor.rs:603; router/transforms/parsers.rs:16; processors/advanced_face/conics.rs:13; profiles/curves_3d.rs:64; profiles/mod.rs:782; curve_segment.rs:101; rust/processing/src/symbolic/transform.rs:193
- Axis2Placement2D: rust/geometry/src/transform/placement_2d.rs:14; profiles/placement.rs:214 (+:177 `parse_operator_axis_2d`); router/transforms/mapped.rs:135
- orthonormaliser: rust/geometry/src/transform.rs:78 `build_axis2_matrix`
- point/direction readers: see XCUT-2 list; core fast path rust/core/src/decoder.rs:615/714/748
- chain walks: see XCUT-27 list; core cache rust/core/src/decoder/caches.rs:114-154
- operator (CartesianTransformationOperator): rust/geometry/src/router/transforms/operator.rs:234; rust/processing/src/symbolic/operator.rs; mapped item: router/transforms/mapped.rs:84 `compose_mapped_transform`
- 2D: rust/processing/src/symbolic/transform.rs:51 `Transform2D`, :114 `compose_transforms`
- site rotation: rust/geometry/src/transform.rs:324 `rotation_angle_about_z`; rust/processing/src/mesh_frame.rs:22 `PLACEMENT_IDENTITY_EPSILON`
- Z-up/Y-up: rust/wasm-bindings/src/zero_copy/frame_swap.rs:25/34; apps/server/src/services/axis.rs:22/30/40; rust/export/src/frame.rs:20/26/40/91/115; rust/export/src/geom.rs:12; rust/export/src/collada.rs:34; rust/processing/src/simplify_math.rs:13/20/26; apps/server/src/services/parquet_instancing.rs:236

**Tolerances / epsilons** (→ `ifc_lite_geometry::tol`) — full 111-row list in `/tmp/xcut/eps.txt`; representative: rust/geometry/src/router/voids/mod.rs:44 `NORMALIZE_EPSILON` 1e-12, :67 `ENGULF_TOLERANCE` 0.03; rust/geometry/src/geom2d.rs:22 `PARALLEL_EPS` 1e-9; processors/structural_edge.rs:32 `PARALLEL_EPSILON` 1e-9; rect_fast.rs:165 `PLANE_TOL` 1e-4; router/voids/geom.rs:745 `PLANE_TOL` 1e-3, :123 `TOUCH_EPS` 1e-3, :213 `AXIS_THRESHOLD` 0.99985; clash_contact_axes.rs:32 `ORTHO_EPS` 1e-4; geom_hash.rs:142 `DEFAULT_GEOM_HASH_TOLERANCE` 1e-3, :159 `MIN_GEOM_HASH_TOLERANCE` 1e-6; profiles/simplify.rs:37-78 RDP constants; profiles/directrix.rs:17 `PARAM_EPS`, :232 `JUNCTION_EPS`, :265 `CHORD_TOL_M`; profiles/curves_2d.rs:143 `CHORD_TOL_M`; csg/consolidate/conform.rs:38 `CONFORM_TOL` 1e-4; csg/consolidate/plane_merge.rs:75/76/170/171; space_dcel/mod.rs:223/228; bool2d.rs:20/23; router/voids/frame_snap.rs:39/44; aabb_clip.rs:71/225; extrusion.rs:201 `PARTIAL_VOID_EPSILON`; processors/swept/disk.rs:15; processors/curve_walk.rs:14 `SEAM_EPS`; rust/clash/src/triangle.rs:17 `EPS` 1e-12, obb.rs:35 `OBB_EPS` 1e-6, tri_mesh.rs:24 `RAY_EPS` 1e-9; rust/core/src/limits.rs:104 `LARGE_COORD_THRESHOLD_METERS`; rust/processing/src/mesh_frame.rs:22, style/mod.rs:59 `TRANSPARENCY_ALPHA_THRESHOLD`, style/surface.rs:169, scan_proposals/frame.rs:39, scan_segmentation/prism.rs:39/40; rust/landxml/src/plan/numeric.rs:18, plan/numeric/parcel_measure.rs:11, alignment/numeric.rs:16 `EPSILON` 1e-9; rust/export/src/geom.rs:9 `AREA_EPS`, merged/units.rs:35 `UNIT_SCALE_TOLERANCE`; apps/server/src/services/parquet_instancing.rs:111 `RECOMPOSITION_TOLERANCE_M`

**Unit conversion** (→ `ifc_lite_core::units::ProjectUnits`)
- rust/core/src/units.rs:31 `extract_length_unit_scale`, :249 `try_extract_length_unit_scale` (+ angle twins); rust/core/src/decoder.rs:357 `length_unit_scale`, :391 `seed_unit_scales`; rust/core/src/unit_labels.rs:25 `try_si_prefix_multiplier`, :51 `get_si_prefix_multiplier`, :58 `get_conversion_based_unit_factor`, :199 `infer_map_unit_scale`; rust/core/src/project_units/{symbols.rs:16, measure.rs:38}; rust/core/src/georef.rs:493-545
- rust/geometry/src/router/mod.rs:297 `scan_unit_scale`, :647 `unit_scale`; profile_extractor.rs:747 `detect_unit_scale`; csg/consolidate.rs:134 `with_unit_scale`
- rust/processing/src/prepass.rs:353 `resolve_unit_scales`, :407 `find_ifcproject_id`
- rust/export/src/merged/units.rs:108 `resolve_length_scale`, :126 `units_compatible`; landxml_terrain_georef.rs:161 `length_unit_metres`; step_log/units.rs:14 `SI_PREFIXES`, :20 `conversion_unit_symbol`, :96 `normalize_map_unit_name`, :122 `find_length_unit_reference`; step_map_transform_preflight.rs:50-70; step_log/georef.rs:60

**BBox / AABB** (→ `Aabb3<T>` in the math module) — see XCUT-8 list

**Hashing** (→ `ifc_lite_core::hash`) — see XCUT-9 list; plus rust/geometry/src/geom_surface.rs:121 `vertex_hash`, kernel/arrangement/boolean.rs:265 `boolean_topology_hash`, kernel/retriangulate.rs:664 `triangulation_topology_hash`, export/src/step_log/readers.rs:31 `hash_ids` (STEP `#id` scan, unrelated)

**Triangulation / polygon ops** (geometry-internal; crate reviewer owns)
- rust/geometry/src/triangulation.rs:56 earcutr wrapper, :284 `triangulate_polygon`, :326 `_with_holes`, :383 `_refined`; triangulation/alt_oracle.rs:42; processors/tessellated/triangulate.rs:12 (218 lines); router/annotation_polygon.rs:12; processors/brep/faceted.rs:112 `triangulate_face`; processors/advanced_face/surfaces.rs:67; cdt.rs:1376/1406/1440/1475; terrain_cdt.rs:43/52; kernel/retriangulate.rs:560; bool2d.rs, contour_bool2d.rs:176 `sanitize`, :237 `sanitize_fixed_grid`; welds: mesh_weld.rs:182/299, mesh_position_weld.rs:18, facet_weld.rs:150, csg/consolidate/ring_ops.rs:43; rust/processing/src/geometry_export.rs:287 `weld_positions`

**Entity attribute access / decoding** (→ core `DecodedEntity` accessors)
- core surface: rust/core/src/schema_gen.rs:117-189 `AttributeValue::{as_entity_ref, as_string, as_enum, as_float, as_int, as_list, is_null}`, :310-336 `DecodedEntity::{get, get_ref, get_string, get_float, get_list, get_refs}`; decoder/schema_layout.rs:49 `attribute_index`; generated schema.rs:7597 `attribute_index`, :8662 `attribute_names`
- re-implemented: rust/export/src/landxml_terrain_georef.rs:139 `text(entity, slot)`; step_map_transform_preflight.rs:341 `required`; rebar_attributes.rs:21 `attribute`; rust/export/src/model_props.rs:139 `opt_string`, :145 `ref_list`; apps/server/src/services/data_model/generated/attr_indices.rs:33 `root_attr_indices` (6,213 lines), relationship_slots.rs:47; apps/server/src/services/data_model/property_value.rs:162-237 `stringify_*`, `resolve_single_value`; rust/processing/src/processor/quick_metadata.rs:90 `parse_step_string`; rust/core/src/step_encoding.rs:86 `decode_ifc_string` (canonical), :199 `hex_val`; rust/geometry/src/processors/texture/raster.rs:36 `hex_val`
- IFCPROJECT locators: 12 sites (XCUT-6)

**Colour / style** (→ `ifc_lite_processing::style`)
- canonical: rust/processing/src/style/mod.rs:103 `Rgba`, :136 `to_rgba8`, :143 `from_rgba8`, :172 `default_color_for_type`, :241 `fixed_display_color_for_type`; style/surface.rs:15 `read_colour_rgb`, :92 `extract_surface_style_colors`; style/material.rs:132 `resolve_submesh_color`; style/indexed_colour.rs:75/132; style/fill.rs:8; element/element_color.rs:29/122/189; processor/color_layer.rs:29; symbolic/color.rs:52/66/75; prepass.rs:306/519/637/660; prepass_styled.rs:107
- duplicates: rust/export/src/color_space.rs:22/29 `srgb(a)_to_linear` (ok, single); export/src/collada.rs:27 `color_key`; export/src/gltf.rs:444 `color_key`, :491 `geom_color_key`; export/src/usd/fmt.rs:14 `color_key`, :30 `linear_color`; export/src/mesh_input.rs:84 `scrub_colors`; rust/processing/src/geometry_export.rs:280 `color_key`; apps/server/src/services/parquet_optimized.rs:48 `color_to_byte`, :62 `MaterialKey::from_color`; apps/server/benches/serialization.rs:311; rust/wasm-bindings/src/api/styling/color.rs:10/134 (wasm-side walk), api/gpu_meshes/prepass_sharded.rs:18 `check_rgba_columns`, batch_partition.rs:206 `style_colors_from_wire`; rust/processing/src/pdf_vector/mod.rs:132 `validate_rgb`

**GUID** (→ `ifc_lite_core::guid`) — see XCUT-10 list

**STEP / number formatting** (→ core `fmt_num`; export format-specific escapers stay)
- rust/export/src/model_props.rs:20 `fmt_num`; apps/server/src/services/data_model/property_value.rs:304 `fmt_number`; rust/export/src/usd/fmt.rs:98 `fmt_f64`, :90 `fmt_f32`; rust/export/src/step_log/jsval.rs:109 `format_step_real`, :126 `to_step_real`, :83 `js_number_to_string`; rust/export/src/step_log/values.rs:89 `step_value`; rust/export/src/step_text.rs:71 `escape`; xml_text.rs:10 `escape`; csv_cell.rs:203 `escape_csv_cell` (csv.rs:46 delegates); usd/fmt.rs:49 `sanitize_ident`, :70 `escape_str`; export/src/lib.rs:164 `sanitize_identifier`; constructions.rs:43 `sanitize`; rust/landxml/src/xml.rs:135 `unescape`; rust/core/src/step_encoding.rs:63 `step_string_literal_end`, :86 `decode_ifc_string`

**Progress / cancellation / budgets** (→ `ifc_lite_core::work`) — see XCUT-14 list

**Error types** (→ one thiserror enum per crate, `kind()`) — see XCUT-15 list; definitions: rust/core/src/error.rs:12; rust/geometry/src/error.rs:12, terrain_cdt.rs:18 `TerrainCdtError`, space_dcel/mod.rs:186 `EditError`, kernel/fixed_int/mod.rs:263; rust/export/src/error.rs:13 `ExportError`, rebar_fabrication.rs:56/70, rebar_preflight.rs:50/62, schema_unrepresented.rs:45, landxml_terrain.rs:153, quantity_analysis_budget.rs:39; rust/landxml/src/model.rs:42 `LandXmlError`, profile.rs:84, terrain_validation.rs:11, terrain_topology.rs:32, alignment/numeric.rs:31; rust/processing/src/analytic_export/checks.rs:52; rust/cloud-import/src/lib.rs:10; rust/wasm-bindings/src/api/landxml_stream.rs:51 `LimitsError`; apps/server/src/error.rs:17 `ApiError`, services/parquet.rs:31, services/parquet_data_model.rs:30; rust/core/src/columnar_index.rs:94

## Target shape

Prioritised by maintainability payoff ÷ effort. Each item names the single home and what gets deleted.

1. **`ifc-lite-math` (zero-dep) — v3/v2/mat4/Aabb3/tol.** Home for XCUT-3, 4, 8, 12, 28: `v3::{dot,cross,sub,add,scale,norm,normalize(eps),lerp,newell_normal}`, `mat4::{IDENTITY,mul,affine_inverse,transform_point,is_identity,to/from nalgebra,row↔col}`, `Aabb3<T>`, `tol::*`. clash depends on it (stays C-free and nalgebra-free), geometry re-exports it. Deletes ~14 vector copies, 4 matrix copies, ~40 bounds folds, the Plato generator. Effort M; payoff: every later refactor stops copying.
2. **Core owns IFC entity reading: `coords3/direction3`, `Axis2Placement`, `placement::resolve_chain`, `ProjectUnits`.** XCUT-1, 2, 6, 26, 27. One attribute-extraction policy (null, dangling, 2-vs-3 coordinates, depth 100), one orthonormaliser, one `IFCPROJECT` locator (the SIMD one), one SI-prefix table. Deletes 9 placement readers, 12 point readers, 60 inline triplets, 11 project scanners, 3 prefix tables, and fixes the NaN and depth-50 bugs as a side effect. Effort M.
3. **One Z-up/Y-up frame module in processing.** XCUT-5. Six homes → one, with the AABB corner-reversal and matrix-conjugation subtleties tested once. Effort S–M, high bug-prevention value for every new transport.
4. **Server consumes the export/model layer instead of re-implementing it.** XCUT-7, 19. Split export's entity-data code into `ifc-lite-model`, make `apps/server` depend on it, delete `data_model/{properties,quantities,relationships,materials,classifications}.rs` and the TS-fed generator (`generated/attr_indices.rs`); the server's parity tests become the oracle. Effort L; payoff: the AGENTS.md "Rust is the source of truth for the server" promise becomes true and a schema bump touches one generator.
5. **One error policy.** XCUT-15. Per-crate thiserror enum with `kind()`, `#[from]` chain core→geometry→processing→export, single `From` into `JsError` and `ApiError`; ratchet `Result<_, String>` in `pub` signatures to zero with a test. Effort L, but can be done crate by crate starting with processing (171 sites).
6. **Workspace dependency inheritance + unused-dep gate.** XCUT-16, 17, 18. `cargo autoinherit`, align `sha2`, delete 7 unused deps, add `cargo machete` to the clippy lane, `[lints] workspace = true` on python and the bench crate, one lockfile. Effort S; do it first because it is pure manifest work and unblocks the crate moves above.
7. **`GeometryConfig` instead of env-var `OnceLock`s and global atomics.** XCUT-20. One struct built in the binaries, passed to the router; feature names normalised to kebab-case; a generated runtime-flags doc. Effort M; payoff: deterministic tests without mutex-serialised globals, and an explicit native-vs-wasm default table.
8. **`WorkObserver` for cancel + progress + budget.** XCUT-14. One trait object carried through `ProcessingOptions`, `GeometryRouter`, `LandXmlLimits`, and the CDT; deletes the `&mut dyn FnMut` threading through 23 signatures and the six `Budget` structs. Effort M.
9. **`ifc-lite-testkit` + integration-test consolidation.** XCUT-22. Fixture resolution/skip, IFC builders, `mesh_volume`, FNV fingerprint in one dev crate; fold the 71 `issue_*` geometry test binaries into topic harnesses. Effort M; payoff: ~200 fewer test crates to link, 200+ jscpd clones gone.
10. **Hash/GUID/colour-key/format micro-homes.** XCUT-9, 10, 11, 13, 25, 29. `core::hash::fnv1a64`, one xxh3 content key (server included), `core::guid`, `Rgba::key_2dp/to_rgba8` used by export and server, `fmt_num` in core, one weld grid. Effort S each; cheap, and each removes a documented-but-violated "single home" claim.

Then (lower priority): split the top-10 functions in XCUT-21 and add a function-length ratchet; fix the docs drift in XCUT-24 as part of each item above rather than as a separate pass.
