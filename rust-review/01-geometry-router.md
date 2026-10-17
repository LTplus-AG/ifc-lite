# Geometry router review (`rust/geometry/src/router/`, ~32k lines incl. ~11k test)

Scope read in full: every non-test file under `router/` (mod, processing, mapped_item, instancing, caching, frame_parts, layers, textured, structural, rep_filter, rtc_offset(+raw_coordinate), annotation*, content_hash, brep_signatures, item_dedup_cache, processor, processor_registry, diagnostics*, transforms/*, voids/* incl. prism_cut/* and synthesis/*), plus `processing/src/element.rs::produce_element_meshes`, `processors/boolean/operand.rs` (the operand dispatch), the native (`processor/jobs.rs`) and wasm (`gpu_meshes/batch.rs`) router set-up, and the crate-level helpers the router re-implements (`transform.rs`, `processors/helpers.rs`, `profile_extractor.rs`, `mesh.rs`, `kernel/signed_volume.rs`, `bool2d.rs`, `geom2d.rs`, `union_find.rs`).

## Summary

- The router is not one dispatcher but four: the element walk (`processing.rs`), the mapped-source walk (`mapped_item.rs`), the don't-bake shared-source walk (`instancing.rs`) and the type-geometry walk (`textured.rs`) each re-implement "resolve IfcRepresentationMap → iterate items → mesh → scale → merge → record drops". The code itself calls them "the four walks". Three of the four bypass `process_representation_item`, so the #5698 f64 RTC rebase and the #4901 curve-cap drain exist on only one or two of them (ROUTER-2, -26, -27).
- The IFC representation chain (`Representation → IfcProductDefinitionShape → Representations → Items`) is hand-walked **10 times**; two of the opening probes skip the `MappedRepresentation` de-dup that `meshed_representations` applies, so an opening with both direct and mapped body geometry gets its cutter twice (ROUTER-1, -28).
- `parse_axis2_placement_3d` / `parse_cartesian_point` / `parse_direction` exist **four times** in the crate (`transform.rs` canonical, `router/transforms/parsers.rs`, `processors/helpers.rs`, `profile_extractor.rs`) and have drifted on null-Location handling, the fast point path, and a `z` default (ROUTER-3).
- The void module has nine edge-pairing "is this mesh closed" walks, five signed-volume implementations, four point-in-polygon and four segment-intersection routines, two Möller–Trumbore copies sharing a copy-pasted magic ray direction, three union-finds beside an unused `crate::union_find`, and the AABB-engulf closure pasted three times in one function (ROUTER-5..-10).
- `classify_openings` meshes every opening **three to five times per host** (parts, per-item bounds, per-item world meshes, fallback bounds again, reconcile again, residual re-classification) and `extend_opening_mesh_through_host` (two full host scans + rays) runs up to five times per cutter (ROUTER-21, -20). `geometry_hash_cache` is dead weight: its `Arc` is deep-cloned on every return (ROUTER-22).
- `apply_void_context_inner` is a 781-line, seven-level-deep function carrying `#[allow(unused_assignments)]`; `prism_cut.rs` is 3,116 lines; ten functions exceed 180 lines (ROUTER-33).
- Flags, counters and diagnostics use four different mechanisms (AtomicI8 override, `OnceLock` env, thread-local test override, router-local `RefCell`) and the per-host diagnostic snapshot/restore struct is implemented twice (ROUTER-17, -18).

## Findings

### ROUTER-1: Representation-chain walk re-implemented 10× (and drifted)
- Category: DRY
- Severity: High
- Confidence: CONFIRMED (drift LIKELY to be observable, see ROUTER-28)
- Where (all sites):
  - rust/geometry/src/router/processing.rs:148-204 (`process_element_parts_with_hygiene`)
  - rust/geometry/src/router/processing.rs:324-362 (`process_element_with_submeshes_impl`) — byte-for-byte copy of the block above
  - rust/geometry/src/router/layers.rs:365-429 (`element_is_single_unshifted_item`)
  - rust/geometry/src/router/rtc_offset.rs:150-182 (`element_has_body_representation`)
  - rust/geometry/src/router/rtc_offset.rs:195-220 (`sample_first_geometry_vertex`)
  - rust/geometry/src/router/voids/probe.rs:253-297 (`body_representation_items`)
  - rust/geometry/src/router/voids/probe.rs:464-509 (`get_opening_item_meshes_world`)
  - rust/geometry/src/router/voids/probe.rs:539-594 (`get_opening_item_bounds_with_direction`) — copy of the previous
  - rust/geometry/src/router/voids/representation.rs:13-33 (`opening_requires_subtraction`)
  - rust/geometry/src/router/mod.rs:527-536 (`geometry_routing_key`, attr 6 only)
- What: each site does `element.get(6)` → null check → `resolve_ref` → `ifc_type == IfcProductDefinitionShape` → `get(2)` → `resolve_ref_list` → per rep `get(3)` → `resolve_ref_list`, with its own error strings and its own body filter. Only three of them use the canonical `meshed_representations` (`rep_filter.rs:55`); `probe.rs:496-500` and `:578-582` re-spell the filter as `effective_element_rep_type ... is_body_representation` and **omit** the `MappedRepresentation`-when-direct-body-exists exclusion that `meshed_representations` and `body_representation_items:265-281` apply. `layers.rs:391-425` stops at the first body rep (others merge all).
- Why it matters: every fix to "what counts as body geometry" (#1661 CATIA blank type, #4433 Reference, #4699, #5389 fills) has to be re-applied in 10 places; two already missed one. ROUTER-28 is the concrete consequence.
- Fix: one `rep_filter::body_items(element, decoder) -> Result<Vec<(DecodedEntity /*shape_rep*/, Vec<DecodedEntity> /*items*/)>>` (plus a `_lossy` variant returning `Option` for the probes) built on `meshed_representations`; delete the nine hand walks.
- Effort: M

### ROUTER-2: The mapped-source item walk exists four times ("the four walks") and three of them bypass the item pipeline
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - rust/geometry/src/router/processing.rs:453-735 (`collect_submeshes_from_item_inner`, mapped arm 473-696)
  - rust/geometry/src/router/mapped_item.rs:102-368 (`process_mapped_item_cached_body`)
  - rust/geometry/src/router/instancing.rs:57-159 (`ensure_shared_mapped_source`)
  - rust/geometry/src/router/textured.rs:84-263 (`process_representation_map_with_texture`)
- What: all four resolve `MappingSource(0) → MappedRepresentation(1) → Items(3)`, open an `enter_unsupported_source` scope, loop items, special-case nested `IfcMappedItem`, call a processor, `validate_indices` + `scale_mesh`, merge, and emit the "skipping unsupported … item" drop block (ROUTER-19). Drift between them:
  - nested mapped items: recursion with depth+visited (processing), recursion (mapped_item), bail-and-don't-cache (instancing), delegate to `process_mapped_item_parts` (textured);
  - `take_curve_capped()` drain: present in mapped_item.rs:256, absent in instancing.rs:109-114 and textured.rs:179-184 (ROUTER-26);
  - f64 RTC rebase (`process_in_rtc_frame`): only the direct path (`process_item_in_rtc_frame`, processing.rs:888) gets it; the three source walks call `processor.process` directly (ROUTER-27);
  - "process → validate_indices → scale_mesh" spelled at processing.rs:912-913, 1133-1134, mapped_item.rs:261-262, instancing.rs:116-117, textured.rs:186-187, annotation.rs:63.
- Why it matters: every per-item invariant (RTC hook, curve-cap drain, index validation, drop accounting, future hygiene) must be added in four places; two of the four have already fallen behind on two invariants.
- Fix: a single `fn walk_source_items(&self, mapped_rep, source_id, nesting: Nesting, sink: &mut impl FnMut(&DecodedEntity, Result<Vec<Mesh>>))` in `mapped_item.rs` that calls `process_item_in_rtc_frame` (never `processor.process`), owns the drop scope, the curve-cap drain and the diag block; the four callers become sinks (merge / push sub-mesh / push textured part / insert into shared cache).
- Effort: M

### ROUTER-3: Axis2Placement3D / CartesianPoint / Direction parsers forked 4× with behavioural drift
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - canonical: rust/geometry/src/transform.rs:26 (`parse_axis2_placement_3d`), :134 (`parse_cartesian_point`, fast path via `get_cartesian_point_fast`), :286 (`parse_direction`)
  - rust/geometry/src/router/transforms/parsers.rs:16, :61, :100 (router methods; textual clone per jscpd ↔ `processors/helpers.rs:51-64, 84-117, 121-143`)
  - rust/geometry/src/processors/helpers.rs:31, :83, :121
  - rust/geometry/src/profile_extractor.rs:603, :647, :677
  - rust/geometry/src/router/transforms/operator.rs:234 (`parse_direction_ratios`, "mirrors `GeometryRouter::parse_direction`, minus the router") and :63-88 (inline IfcCartesianPoint read)
- What / drift: (i) null `Location` → `Err` in transform.rs and router, → origin `(0,0,0)` in helpers.rs:36-44 and profile_extractor.rs:607-608; (ii) only transform.rs uses the `get_cartesian_point_fast` byte path — the router's placement walk (`walk.rs:159 → parsers.rs:17`) fully decodes every `IfcCartesianPoint` into `AttributeValue`s, the exact per-point allocation `content_hash.rs:292-297` documents as the "~8 s" cost; (iii) `profile_extractor::parse_direction_entity` defaults a missing third ratio to **1.0** (line 688) where the other three default to 0.0, so a 2-component `IfcDirection` used as `Axis` yields `(x,y,1)` in the 2D drawing path and `(x,y,0)` in the mesh path; (iv) `transform.rs:71-73` doc normalises the fork ("every parser in the crate keeps its own attribute extraction").
- Why it matters: the mesh, drawing and router placements can disagree on the same entity; `#1985` already fixed one such divergence for the transformation operator by collapsing to one definition — the placement parsers were left forked.
- Fix: delete `parsers.rs` bodies, `helpers.rs:31-143`, `profile_extractor.rs:603-690`; make `GeometryRouter::parse_axis2_placement_3d` a one-line delegate like `parse_axis2_placement_2d` already is (`mapped.rs:135-141`). Decide null-Location policy once (origin is the IFC-correct default) and keep the fast path.
- Effort: S

### ROUTER-4: "Unwrap mapped/boolean chain to IfcExtrudedAreaSolid" walk ×4
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - rust/geometry/src/router/voids/probe.rs:75-135 (`extract_extrusion_direction_recursive`: depth loop + visited)
  - rust/geometry/src/router/voids/probe.rs:302-342 (`rect_param_from_item`: `visited.len() > MAX` cap)
  - rust/geometry/src/router/voids/probe.rs:712-752 (`extruded_solid_from_item`: refuses booleans, requires exactly one item)
  - rust/geometry/src/router/layers.rs:436-479 (`item_has_identity_position`: boolean-only, iterative)
  - (cross-module) rust/geometry/src/processors/boolean `collect_polygonal_chain`, cited by layers.rs:444
- What: four loops over `IfcMappedItem → MappingSource → MappedRepresentation → Items[0]` / `IfcBooleanResult → FirstOperand` accumulating `mapped_item_transform`. Drift: `rect_param_from_item:338` silently takes `.next()` on a multi-item map (drops the rest, relies on the later volume reconcile to catch it) while `extruded_solid_from_item:742-746` refuses; bound mechanism differs per copy (AGENTS.md "Bounding walks" asks for one shared bound).
- Why it matters: the parametric and 2D fast paths derive the cutter FRAME from these walks; a divergence is a silent mis-cut class the comments on both sites warn about.
- Fix: `probe::unwrap_solid(item, decoder, Policy { through_booleans: bool, single_item: bool }) -> Option<(DecodedEntity, Matrix4<f64>)>`; the four callers pass a policy.
- Effort: S

### ROUTER-5: Nine "edge-pairing closed-surface" walks
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - rust/geometry/src/router/voids/geom.rs:166 `mesh_is_closed_exact` (bit-exact, directed, **returns false on a degenerate edge**)
  - rust/geometry/src/router/voids/geom.rs:402 `topology_defect_count` + :394 `param_cut_watertight` (1e-4 grid, undirected, skips degenerate)
  - rust/geometry/src/router/voids/malformed_opening_repair.rs:101 `cutter_is_closed_manifold` (1e-5 weld via `welded_by_position`, undirected, needs ≥4 tris)
  - rust/geometry/src/router/voids/frame_snap.rs:165 `strictly_paired_at` (1e-4 and 1e-3 grids, directed (1,1) rule)
  - rust/geometry/src/router/voids/prism_cut/closure_checks.rs:48 `directed_edge_counts` → `directed_closed`, `closed_or_hairline`, `ClosureVerdict` (1e-4 grid, directed ±)
  - rust/geometry/src/router/voids/prism_cut/closure_checks.rs:338 `edge_multiplicity_defects` (exact bits, −0 folded)
  - rust/geometry/src/router/voids/prism_cut/tjunction_close.rs:53-66 balance map (1e-4 grid, directed ±, inline)
  - rust/geometry/src/router/voids/sweep.rs:118 `overlapping_components` (bit-exact union-find)
  - rust/geometry/src/test_support.rs:20 `open_edges`, rust/geometry/src/rect_fast.rs:520 `open_edges` (tests)
- What: identical skeleton (`key(i)` quantiser → `chunks_exact(3)` → skip degenerate → `entry((a,b)) ± 1`), differing only in quantum and in whether the tally is directed. The docs justify *why* each predicate differs; nothing justifies nine hash walks.
- Why it matters: 9 places to fix the next quantisation bug (e.g. `-0.0` folding is done only in `edge_multiplicity_defects`); each walk is O(T) and several run back-to-back on the same mesh (`try_cut_wall_local_frame` runs `closed_as_emitted` which clones + cleans + two `strictly_paired_at` passes, then `enclosed_volume`).
- Fix: `mesh_tjunction::EdgeLedger::build(mesh, VertexKey::{Exact, Grid(f64), Welded(f32)})` exposing `directed_balance()`, `undirected_uses()`, `is_strictly_closed()`, `defects()`, `components()`; every predicate becomes a 1-3 line query on one ledger, and callers that need two predicates share one build.
- Effort: M

### ROUTER-6: Signed volume ×5, surface area ×2
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/geometry/src/router/voids/geom.rs:331 `mesh_signed_volume`, :360 `mesh_signed_volume_about` (canonical; uses `kernel::signed_volume::tetra_volume6`)
  - rust/geometry/src/router/voids/frame_snap.rs:190 `enclosed_volume` — same semantics as `mesh_signed_volume` (bounds-centre reference), hand-expanded determinant
  - rust/geometry/src/router/voids/prism_cut.rs:1249-1260 inline `vol6` in `prepare_prism`
  - rust/geometry/src/router/voids/prism_cut.rs:356-363 `sum` closure in `partition_consistent`
  - rust/geometry/src/world_frame_fixture.rs:125 `mesh_volume`; rust/geometry/src/kernel/mesh_volume.rs:74 `mesh_volume` (its doc even cross-references `geom::mesh_signed_volume` as "the same sum")
  - surface area: rust/geometry/src/router/voids/prism_cut.rs:461-468 (`area` closure), rust/geometry/src/router/voids/prism_cut/tjunction_close.rs:148 `surface_area`
- Why it matters: reference-point rules (#4632) were fixed in `geom.rs` only; `frame_snap::enclosed_volume` is used for the "same cut to within 0.1 %" decision in `try_cut_wall_local_frame:906-940` with its own copy.
- Fix: `Mesh::signed_volume()`, `Mesh::signed_volume_about(o)`, `Mesh::surface_area()` in `mesh.rs` delegating to `kernel::signed_volume`; delete the rest.
- Effort: S

### ROUTER-7: 2D point-in-polygon ×4, segment intersection ×5, polygon area/CCW ×4
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - PIP: rust/geometry/src/router/voids/prism_cut.rs:274 `pip` (even-odd), :1516 `point_in_or_on`; rust/geometry/src/router/annotation_polygon.rs:86 `inside` (winding, exact orient2d); crate: rust/geometry/src/bool2d.rs:241 `point_in_contour`, rust/geometry/src/geom2d.rs:52 `point_in_polygon`
  - segment/line intersection: rust/geometry/src/router/voids/prism_cut.rs:295 `seg_cross_param` (E=1e-12), :2594-2607 inline copy inside `resolve_crossings` (E=1e-9 — drifted), :1638 `isect` closure; rust/geometry/src/router/annotation_polygon.rs:75 `intersects`; rust/geometry/src/router/transforms/grid.rs:244 `line_intersection_2d`
  - area/orientation: rust/geometry/src/router/voids/prism_cut.rs:801 `ccw_area`; rust/geometry/src/bool2d.rs:201 `compute_signed_area` + :219 `ensure_ccw`; rust/geometry/src/geom2d.rs:38 `polygon_area`; rust/geometry/src/router/voids/bool2d_path/footprint.rs:14 `area_abs`
- What: `prism_cut.rs` carries its own "small f64 vector kit" (lines 214-311) for FMA-freedom, but `geom2d.rs` / `bool2d.rs` are already plain-f64 component arithmetic; nothing in prism_cut needs a different PIP rule than `geom2d::point_in_polygon`.
- Fix: `geom2d.rs` is the single 2D kit (PIP, on-segment, seg-seg param, signed area, ensure_ccw, simplify_collinear); prism_cut/annotation/grid import it.
- Effort: S

### ROUTER-8: Möller–Trumbore and the parity ray direction duplicated
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/voids/geom.rs:443-470 `ray_triangle_param` + :556 `PARITY_DIR_A` + :561 `parity_along`; rust/geometry/src/router/voids/prism_cut.rs:1410 `RAY_DIR` ("same constants as `geom::point_inside_mesh`") + :1414-1447 `point_inside` (inline MT with AABB reject, EPS 1e-12 vs 1e-9).
- Why it matters: the two parity tests are used on the same host inside one cut (`try_prism_cut` vs `apply_void_context_inner`); a change to the ray direction or epsilon in one silently desynchronises the inside/outside verdicts.
- Fix: one `geom::ray_triangle_param` over `[f64;3]`, one `PARITY_DIR_A`, `point_inside(tris, Some(aabbs), p)`.
- Effort: S

### ROUTER-9: Face-normal clustering ×4
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/voids/geom.rs:688-720 (`is_rectangular_box_mesh`, cos 0.98), :766-799 (`infer_opening_frame`, 0.98, area-weighted merge), rust/geometry/src/router/voids/local_frame.rs:117-150 (`dominant_horizontal_normal`, 0.98, area-weighted merge, identical loop to `infer_opening_frame`), rust/geometry/src/router/voids/prism_cut.rs:949-962 (`detect_prism`, 0.999).
- Fix: `geom::cluster_face_normals(mesh, cos_tol, weighted) -> Vec<(Vector3, f64)>`.
- Effort: S

### ROUTER-10: Cutter admission guards and the engulf test pasted in-line
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - engulf `covers` closure: rust/geometry/src/router/voids/mod.rs:1292-1301 (f64), :1493-1502 (f32, uses the separate `ENGULF_TOLERANCE_F32`), :1586-1595 (f64), rust/geometry/src/router/voids/prism_cut.rs:2945-2949 (4th); the comment at mod.rs:64-68 claims the constant sharing prevents drift, but the code is copied and one copy is `f32`.
  - admission (`opening_valid` / `no_overlap` / volume floor): mod.rs:1260-1281 (batch, "Same admission guards as the sequential loop"), mod.rs:1450-1481 (sequential), rust/geometry/src/router/voids/coaxial_union.rs:158-178 (prepass); `wall_min/max` `Point3<f64>` conversion of `bounds()` at mod.rs:730-732, :1113-1122, :1431-1435.
  - acceptance (`min_tris = tri_before / CSG_TRIANGLE_RETENTION_DIVISOR`): mod.rs:1400-1402, :1536-1538, coaxial_union.rs:510-524 `accept_cut`.
- Fix: `voids::admission::{admit_cutter(mesh, host_bounds, min_vol) -> Option<Admitted>, aabb_engulfs(lo,hi,host_lo,host_hi), accept_cut(..)}`; one `ENGULF_TOLERANCE`.
- Effort: S

### ROUTER-11: Five AABB representations and six "bounds with origin folded" implementations
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `(Point3<f32>,Point3<f32>)` (`Mesh::bounds`), `[f32;6]` (`local_bounds`, `frame_parts.rs:78 mesh_bounds`), `((f32,f32,f32),(f32,f32,f32))` (`HostOpeningDiagnostic.host_bounds`, `world_host_bounds` malformed_opening_repair.rs:303), `HostBbox{min,max}` (diagnostics.rs:91), `([f64;3],[f64;3])` (prism_cut, coaxial_union). Origin-folded bounds: malformed_opening_repair.rs:303-323, synthesis.rs:41-46, synthesis.rs:285-296, prism_cut.rs:1385-1392, probe.rs:627-681 (8-corner transform loop, also duplicated at mesh_world.rs:45-54), mesh_world.rs:223-240 and :242-255 (two AABB loops in one function), frame_parts.rs:78.
- Fix: `Mesh::bounds_f64()`, `Mesh::world_bounds()` (origin folded), `Mesh::local_bounds_f32()`; one `Aabb3` type reused by diagnostics.
- Effort: S

### ROUTER-12: `Mesh { … }` struct literal spelled out 5× while `Mesh::rebuilt_like` exists
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/voids/frame_project.rs:59-71, rust/geometry/src/router/voids/geom.rs:280-288, :316-324, rust/geometry/src/router/voids/malformed_opening_repair.rs:333-344, rust/geometry/src/router/voids/prism_cut.rs:558-569; constructor: rust/geometry/src/mesh.rs:295.
- What: each literal re-decides which metadata to keep (origin kept / zeroed / composed, normals kept / dropped / zeroed, `rtc_applied` kept). Adding a `Mesh` field means five edits plus `rebuilt_like`.
- Fix: `template.rebuilt_like(positions, normals, indices).with_origin(o)`.
- Effort: S

### ROUTER-13: MappingTarget bake + `InstanceMeta` construction ×5
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/processing.rs:572-583, :683-686, :1064-1070; rust/geometry/src/router/mapped_item.rs:147-166, :347-365; `scale_transform` + `mat4_to_row_major` pairs at processing.rs:573-574, :641, :684-685, mapped_item.rs:148-150, :349-351, textured.rs:228-229.
- Fix: `InstanceMeta::instanceable(rep_identity: u128, local: Option<[f64;16]>)` and `GeometryRouter::scaled_row_major(&Matrix4) -> [f64;16]`.
- Effort: S

### ROUTER-14: Matrix4 → `[f64;16]` flatten spelled 5 ways
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/transforms/mod.rs:101 (`first_chunk::<16>().expect`), rust/geometry/src/router/mod.rs:716-717 and rust/geometry/src/router/transforms/mod.rs:288-290 and rust/geometry/src/router/transforms/linear.rs:89-90 (`copy_from_slice(as_slice())`), rust/geometry/src/router/transforms/mapped.rs:43 (`array::from_fn(|i| as_slice()[i])`); cross-crate: rust/geometry/src/analytic/profile.rs:134, rust/geometry/src/analytic/extrusion.rs:97, rust/processing/src/analytic_export/definitions.rs:131.
- Fix: `pub fn mat4_to_col_array` in `crate::transform` (next to `rotation_angle_about_z` which consumes that layout).
- Effort: S

### ROUTER-15: Placement application duplicated (single-mesh vs sub-mesh, lax vs strict)
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/transforms/mod.rs:130-170 (`apply_placement`) vs :183-230 (`apply_submesh_placement`); rust/geometry/src/router/mod.rs:709-719 (`resolve_scaled_placement`) vs rust/geometry/src/router/transforms/mod.rs:267-291 (`resolve_scaled_placement_strict`); `get_placement_transform_from_element` + `scale_transform` pair at processing.rs:824-825, layers.rs:226-227, rtc_offset.rs:77-80, probe.rs:485-488, :565-568.
- What: both appliers resolve attr 5, scale, stamp `instance_meta.transform`, call `transform_mesh_world`, and each duplicates its identity fallback twice (null attr / unresolved ref).
- Fix: `fn element_world_placement(&self, element, decoder, strict: bool) -> Result<(Matrix4<f64>, bool)>` (already scaled) and `fn place_mesh(&self, mesh, &transform)`; `apply_submesh_placement` = weld loop + `place_mesh` loop.
- Effort: S

### ROUTER-16: Optional-reference ladders and the parent-placement walk
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: parent walk `match placement.get(i) { Some(a) if !a.is_null() => match decoder.resolve_ref(a)? { Some(p) => …depth+1, None => identity }, _ => identity }` at rust/geometry/src/router/transforms/walk.rs:144-152, linear.rs:36-44, grid.rs:46-53; "attr → non-null → resolve → default" ladders at parsers.rs:25-51, operator.rs:63-88, :119-131, :135-145, :150-159, probe.rs:51-67, :153-183, walk.rs:155-171, textured.rs:224-236.
- Fix: `EntityDecoder::resolve_optional(attr) -> Result<Option<DecodedEntity>>` (null → `None`) in core, and `fn parent_walk(&self, placement, attr, decoder, depth) -> Result<PlacementWalk>` in walk.rs.
- Effort: S

### ROUTER-17: Env flags and test overrides via four different mechanisms
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/mod.rs:66 + :374-394 (`DEDUP_EXTRA_OVERRIDE` AtomicI8 −1/0/1 + `OnceLock` env), rust/geometry/src/router/transforms/mod.rs:27-77 (`LOCAL_FRAME_OVERRIDE`, identical encoding), rust/geometry/src/router/voids/prism_cut.rs:88-91, bool2d_path.rs:57-60, coaxial_union.rs:82-92 (+ `thread_local!` test override at :66-78), rust/geometry/src/rect_fast.rs:67/94, rust/geometry/src/kernel/budget.rs:131/140.
- Why it matters: tests for one flag race the process-global `OnceLock` of another (coaxial_union invented a thread-local to dodge exactly that); the override encodings are copy-pasted.
- Fix: `struct EnvFlag { env: &'static str, default: bool, override_: AtomicI8 }` with `get()`, `set_override(Option<bool>)`, one per flag as a `static`.
- Effort: S

### ROUTER-18: Per-host diagnostic snapshot/restore implemented twice; counters half request-local, half process-global
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/voids/staged.rs:67-116 (`HostAttempt`) and rust/geometry/src/router/voids/frame_snap.rs:215-251 (`HostDiagSnapshot`) — same four fields (`csg_failures`, `host_diag`, `consumed`, `rect_fast`), same restore body. Counters: router-local `rect_fast_stats` (mod.rs:176-182, explicitly moved off a process-global because concurrent native builds bled) vs process-global atomics `FIRES/FOOTPRINTS` (bool2d_path.rs:62-74), prism `diag` (prism_cut.rs:103-212), `telemetry_transaction`.
- Fix: one `HostDiagSnapshot` with an RAII `accept()`; move bool2d/prism/coaxial counters into a router-local `VoidPathStats` drained like `take_rect_fast_stats`.
- Effort: S

### ROUTER-19: "skipping unsupported item" drop block ×9
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/processing.rs:624-636, :718-730; mapped_item.rs:225-237, :266-278, :282-294; instancing.rs:121-133, :136-148; textured.rs:146-158, :191-203, :206-218 (each: `record_unsupported_item(ty)` + `diag_debug!{…} else { #[cfg(debug_assertions)] eprintln!(…) }`).
- Fix: `fn drop_item(&self, item: &DecodedEntity, reason: DropReason /* NoProcessor | Failed(&Error) | NestedMapFailed(&Error) */)`.
- Effort: S

### ROUTER-20: `extend_opening_mesh_through_host` recomputed up to 5× per cutter
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/voids/coaxial_union.rs:188 (overlap graph), :437-443 (`max_removed`), coaxial_union3d.rs:22 (union fallback), batch_cutter.rs:23 (`batch_cutter`, called at mod.rs:1283 for admission and :1380 after mutation) and :62 (`batch_cutters_match_sequential` recomputes the raw cutter per member), mod.rs:1523 (sequential).
- What: each call runs `remove_internal_membrane` (full cutter pass + HashMap) and `exit_cap::detect` (full host triangle scan + `project_aabb_in_frame` + up to 6 parity rays, each a full host scan). For a host with N openings this is O(5·N·host_tris) before any boolean runs.
- Fix: memoise per `(opening_idx, host_generation)` in `apply_void_context_inner` (`host_mutated` already tracks the generation).
- Effort: S

### ROUTER-21: Every opening is meshed 3–5× per host during classification
- Category: Perf
- Severity: High
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/voids/synthesis.rs:103 (`process_element_parts_with_hygiene(opening)` — full build), :157 (`get_opening_item_bounds_with_direction` → probe.rs:620 `process_representation_item_parts` per item — 2nd build), :196 (`get_opening_item_meshes_world` → probe.rs:514-516 — 3rd build with placement), :172 (`fallback_aabb_for_opening` → `get_opening_item_bounds_with_direction` again, per part — 4th), rust/geometry/src/router/voids/mod.rs:460 (`opening_boxes_reconcile` → `get_opening_item_meshes_world` — 5th, when `param_enabled`), rust/geometry/src/router/voids/bool2d_path.rs:192 (`classify_openings_quiet` for residual ids — all of the above again).
- Why it matters: `VoidContext` docs call classification "the expensive half"; the content-dedup cache only covers brep/extrusion/boolean item types and never the placement, weld and `transform_mesh_world` work, so a 47-opening slab (the #129 case) pays ~200 item builds for 47 cutters.
- Fix: `OpeningGeometry { parts: Vec<Mesh>, items: Vec<OpeningItem { mesh_world, bounds, extrusion_dir }> }` built once per opening id per router (a `RefCell<FxHashMap<u32, Rc<OpeningGeometry>>>`), consumed by classify, fallback, reconcile and residual.
- Effort: M

### ROUTER-22: `geometry_hash_cache` is dead weight
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/caching.rs:130-152 (`get_or_cache_by_hash`), sole caller rust/geometry/src/router/processing.rs:1092-1093 (`let cached = self.get_or_cache_by_hash(mesh); return Ok((*cached).clone());`), field mod.rs:128 (no other reader).
- What: the returned `Arc` is deep-copied immediately, so nothing is ever shared. Net effect per uncached item: a sampled hash, a full `positions`/`indices` equality compare on every hit, and a private copy of every unique item mesh retained for the router's lifetime (the wasm batch router keeps every item mesh of the batch twice until the batch ends). `compute_mesh_hash` (sampled u64) exists only for this cache; `compute_mesh_hash_full` (u128) is the one instancing uses.
- Fix: delete `geometry_hash_cache`, `compute_mesh_hash`, `meshes_equal` and the three cache tests (the #833 regression concerned this cache only); keep `compute_mesh_hash_full` next to `geom_hash.rs`.
- Effort: S

### ROUTER-23: Layered slicing attempted twice for voided sliceable walls (stale comment)
- Category: Perf
- Severity: Medium
- Confidence: LIKELY
- Where: rust/geometry/src/router/voids/mod.rs:1805 (`try_layered_sub_meshes(.., Some(void_index))`) then :1816 → rust/geometry/src/router/processing.rs:320 (`try_layered_sub_meshes(.., None)`).
- What: when the voided slice declines (e.g. "fewer-than-two-sub-meshes", "cut-produced-<2"), `process_element_with_submeshes_impl` re-runs the whole attempt with an empty void index — `process_element_with_voids` (full element build + planes + N−1 clips) a second time — and `push_layer_slice_diag` records the element twice. The comment at processing.rs:316-319 ("the caller's has_openings branch takes the voids-aware path below") predates the void path calling `_impl`.
- Fix: give `_impl` a `try_layers: bool` (or move the layered attempt out of `_impl` into the two public entry points).
- Effort: S

### ROUTER-24: `IfcSchema::new()` / `.clone()` built per placement, per grid axis, per opening solid
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/transforms/linear.rs:149, rust/geometry/src/router/transforms/grid.rs:161 (one per `IfcGridAxis`, two per intersection), rust/geometry/src/router/voids/probe.rs:755 (`self.schema.clone()` per opening solid in the 2D path), processor_registry.rs:74-83 (`schema.clone()` ×5 per router), rust/geometry/src/alignment.rs:387/406, processors/{swept,sectioned,boolean}.
- What: `IfcSchema` is two `HashMap`s with ~40 inserts (core/schema_gen.rs:357+); the router already keeps a `static SCHEMA: OnceLock` (mod.rs:250) precisely to avoid this, and the native pool builds a router per element (jobs.rs:185), so five clones per element plus the per-call `new()`s.
- Fix: `IfcSchema::global() -> &'static IfcSchema`; `ProfileProcessor::new(&'static IfcSchema)`; processors hold `&'static`.
- Effort: S

### ROUTER-25: Small hot-path waste in the void loops
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/voids/mod.rs:1266 and :1458 (`result.bounds()` recomputed per candidate → O(N·V)); :1018 (`original_host = mesh.clone()` unconditionally, used only when `host_mutated` and under `SWEEP_COST_BUDGET`); :1810 (`ids.clone()`); rust/geometry/src/router/processing.rs:226 (`mesh_bounds(&mesh)` per item even when only `union_bounds` needs it); rust/geometry/src/router/voids/frame_snap.rs:160 (`closed_as_emitted` clones + cleans the full result just to test closure).
- Fix: hoist bounds, clone lazily, pass `&[u32]`.
- Effort: S

### ROUTER-26: Curve-capped flag (#4901) not drained on two of the four source walks
- Category: Bug
- Severity: Medium
- Confidence: LIKELY
- Where: rust/geometry/src/router/instancing.rs:109-114 and rust/geometry/src/router/textured.rs:179-184 call `processor.process(..)` with no `take_curve_capped()`; the drain exists only at mapped_item.rs:256-258 and processing.rs:775-777 / mapped_item.rs:62-64.
- What: a B-spline edge over the segment cap inside a don't-bake shared source or a type-geometry `RepresentationMap` sets the thread-local flag; nothing on that walk reads it, so the next `process_representation_item` on the same thread records `IfcBSplineCurveWithKnots` against an unrelated element — the exact mis-attribution the mapped_item.rs:249-255 comment says was fixed.
- Scenario: native pool, element A = IfcBoilerType with a `RepresentationMap` containing an `IfcAdvancedBrep` whose edge exceeds the cap; element B (next on the rayon worker) = a plain extrusion → B's diagnostics gain a phantom capped-curve drop.
- Fix: falls out of ROUTER-2 (one walk, drain inside).
- Effort: S

### ROUTER-27: Raw-coordinate items inside mapped sources never get the f64 RTC rebase
- Category: Bug
- Severity: Medium
- Confidence: LIKELY
- Where: rust/geometry/src/router/mapped_item.rs:241-248, instancing.rs:108-114, textured.rs:178-184 call `processor.process`, never `process_in_rtc_frame`; the rebase lives only in `process_item_in_rtc_frame` (processing.rs:888-918), reached by direct items and by `process_representation_item_uncached` (comment at :1083-1085 claims "this frame matters for mapped and opening items", but mapped SOURCES never reach it — only the `IfcMappedItem` wrapper does, and it is intercepted at :949).
- Scenario: a national-grid `IfcTriangulatedFaceSet` (#5698's case) referenced through an `IfcRepresentationMap` (Civil 3D exports mapped terrains): the source mesh is narrowed to f32 at ~5e6 m (0.5 m ULP) before `MappingTarget` and placement; the #5698 fixture passes only because it is a direct item.
- Fix: ROUTER-2 (the shared walk calls `process_item_in_rtc_frame`), plus a mapped variant of `issue_5698`'s test.
- Effort: S

### ROUTER-28: Opening probes mesh a `MappedRepresentation` even when direct body geometry exists
- Category: Bug
- Severity: Low
- Confidence: LIKELY
- Where: rust/geometry/src/router/voids/probe.rs:496-500 and :578-582 (filter is `is_body_representation` only), versus `meshed_representations` (rep_filter.rs:74-84) and `body_representation_items` (probe.rs:265-281) which exclude the mapped rep when `has_direct_geometry`.
- Scenario: an `IfcOpeningElement` carrying both `Body/Brep` and `Body/MappedRepresentation` of the same solid (the duplication #4699 handles for products). `classify_openings` gets `item_bounds_with_dir.len() == 2` for one void → two cutters (`spatial_cluster_count` = 1 so no split), and `opening_boxes_reconcile` sees 2× mesh volume → the parametric path always defers for that host.
- Fix: ROUTER-1.
- Effort: S

### ROUTER-29: Processor-failure sweep order depends on `std::HashMap` iteration
- Category: Bug
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/processor_registry.rs:118 (`overrides: HashMap<IfcType, _>` with `RandomState`), :152 (`values()` chains overrides first), consumed by rust/geometry/src/router/diagnostics/processor_failures.rs:51.
- What: with two or more custom processors registered (e.g. a test `RtcAwareFace` plus a boolean override), the order of `BoolFailure` records in the `UNATTRIBUTED_PRODUCT_ID` bucket varies per process. `aggregate_diagnostics` sorts by reason, but the raw `take_csg_failures()` Vec is exposed to callers.
- Fix: `FxHashMap` (deterministic) or a `Vec<(IfcType, Rc<_>)>`.
- Effort: S

### ROUTER-30: `partial_cmp().unwrap()` on half-extents
- Category: Bug
- Severity: Low
- Confidence: SUSPECT
- Where: rust/geometry/src/router/voids/geom.rs:234 (`thin_axis`), rust/geometry/src/router/voids/malformed_opening_repair.rs:26 (`OpeningBox::thin_axis`).
- What: aborts (panic=abort) on a NaN half-extent. `rect_param_from_item` guards `x_dim/y_dim/depth` finiteness and `try_normalize` rejects NaN axes, and `OpeningBox` extents come from finite inliers, so today unreachable; but `membrane.rs:66-71` explicitly switched the same construct to `total_cmp` for the `1.E999` case — the two spellings will drift.
- Fix: `total_cmp` everywhere (or the `tol` module's `argmin`).
- Effort: S

### ROUTER-31: Two vertex-access conventions in one module (checked `mesh_point` vs unchecked indexing)
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: checked: rust/geometry/src/router/voids/geom.rs:430 `mesh_point` (used by sweep, local_frame, exit_cap); unchecked `positions[b..]`: geom.rs:372 `mesh_vertex` (doc: "an out-of-range index panics"), :168-174, :403-411, frame_snap.rs:166-168, :197-199, closure_checks.rs:49-56, :345-352, membrane.rs:47-52, coaxial_union.rs:587-594 (then bounds-checks indices separately), prism_cut.rs:462-463.
- Why it matters: panic=abort in the viewer worker; the kernel's outputs are trusted but `candidate` meshes from `apply_void_context` recursion are audited by `topology_defect_count` without validation.
- Fix: `Mesh::vertex(i) -> Option<[f64;3]>` + `Mesh::validate_indices()` once at the void-path entry; drop `mesh_vertex`.
- Effort: S

### ROUTER-32: `OpeningType` tuple variants projected ad hoc 7×
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/voids/mod.rs:221-227 `mesh_cutter`, :232-245 `translated`, :967-973 `depth_of`, :1427-1445 `normalized`, rust/geometry/src/router/voids/frame_snap.rs:253-266 `parts`, rust/geometry/src/router/voids/local_frame.rs:17-24 `authored_depth`, rust/geometry/src/router/voids/prism_cut.rs:1380-1404 `opening_aabb_obb`, plus `match` ladders in synthesis, coaxial_union, batch_cutter.
- Fix: `struct Cutter { kind: CutterKind, mesh: Option<Mesh>, bounds: Aabb3 /*world, origin folded*/, depth: Option<Vector3<f64>>, frame: Option<OpeningFrame>, depth_is_authored: bool }` with the seven accessors as methods.
- Effort: M

### ROUTER-33: God functions and a 3,116-line file
- Category: Maintainability
- Severity: High
- Confidence: CONFIRMED
- Where (lines): rust/geometry/src/router/voids/mod.rs:1000-1780 `apply_void_context_inner` (781, nesting depth 7, `#[allow(unused_assignments, clippy::too_many_arguments)]`, `#[allow(unused_variables)]` inside); rust/geometry/src/router/voids/prism_cut.rs:2805-3115 `try_prism_cut` (310), :1886-2118 `cut_prism` (232), :944-1136 `detect_prism` (193), :1571-1695 `extend_profile_edges` (125); rust/geometry/src/router/processing.rs:453-735 `collect_submeshes_from_item_inner` (283, 7 params); rust/geometry/src/router/voids/synthesis.rs:73-319 `classify_openings_impl` (247, 6 nested `bump(..)`/`push` pairs), :435-649 `extend_opening_along_direction` (215); rust/geometry/src/router/voids/mod.rs:775-957 `try_cut_wall_local_frame` (183); rust/geometry/src/router/textured.rs:84-263 (180); rust/geometry/src/router/voids/mapped_item.rs:102-368 (267).
- Why it matters: `apply_void_context_inner` alone sequences nine strategies (local-frame, facet weld, rect_fast, subdivision, coaxial union, disjoint batching, sequential exact + #635 fallback + engulf/redundant guards, sliver refinement, malformed recut, flap clip, shard sweep) with shared mutable `result/host_mutated/batch_consumed` state; `#[allow(unused_assignments)]` exists because the control flow is no longer analysable.
- Fix: see `## Target shape` — an ordered `Vec<Box<dyn CutStrategy>>` with a uniform `try_cut(host, &[Cutter]) -> CutOutcome { Cut{mesh, residual}, Defer }` contract, the exact-kernel strategy last, and the post-passes as a second ordered list.
- Effort: L

### ROUTER-34: The built-in processor table is written three (really four) times
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/processor_registry.rs:23-44 (`TYPES: [&[IfcType]; 20]`), :46-70 (`slot()` match — the same mapping inverted), :72-96 (`create()` match — the same mapping as constructors), plus every processor's `supported_types()` (fourth statement). Adding a processor = 4 edits + bumping the array length literal.
- Fix: `const BUILTINS: &[Builtin { types: &[IfcType], make: fn(&IfcSchema) -> Rc<dyn GeometryProcessor> }]`; `slot()` = linear scan (20 entries) or a `phf`; drop `supported_types()` from the trait for built-ins (keep it for overrides).
- Effort: S

### ROUTER-35: Per-IFC-type special cases that should be data-driven (`IfcSchema::geometry_types` exists and is unused by the router)
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where: hand-written `matches!`/`match` over the same families — brep family (rtc_offset.rs:240-243, raw_coordinate.rs:18-21, layers.rs:496-499, brep_signatures.rs:53), tessellated family (rtc_offset.rs:251-253, raw_coordinate.rs:25-27, layers.rs:500-502, processing.rs:382-385, :847, textured.rs:165, brep_signatures.rs:66-67), surface-model family (rtc_offset.rs:260, raw_coordinate.rs:37, layers.rs:503-504, brep_signatures.rs:68-69), swept family (layers.rs:486-489), boolean family (layers.rs:459-461, probe.rs:101, :317, content_hash.rs comments), face family (rtc_offset.rs:281, raw_coordinate.rs:22). `IfcSchema.geometry_types: HashMap<IfcType, GeometryCategory>` (core/schema_gen.rs:349) was built for exactly this and only `profile_extractor` consults it.
- Fix: `IfcType::geometry_family() -> Option<GeometryFamily>` (const table in core) and dispatch on the family; the "first vertex" probe (ROUTER-36) and the raw-coordinate predicate become one match each.
- Effort: M

### ROUTER-36: Three navigations of shell → face → bound → loop → point
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/rtc_offset.rs:296-370 (`brep_first_vertex`/`shell_first_vertex`/`face_first_vertex`/`tessellated_first_vertex`) + rust/geometry/src/router/rtc_offset/raw_coordinate.rs:12-50; rust/geometry/src/router/content_hash.rs:159-188 (`try_faceted_brep_signature`, byte-level via `get_entity_ref_list_fast`/`get_face_bound_fast`/`get_polyloop_coords_cached_into`); the `FacetedBrepProcessor` traversal (outside scope) is the third.
- Fix: a `core::brep_walk::first_point(decoder, item) -> Option<(f64,f64,f64)>` on the fast byte paths; the RTC probe and the signature both consume it.
- Effort: S

### ROUTER-37: Silent loss paths with no diagnostic record
- Category: Quirk
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/voids/synthesis.rs:88-91 (`decode_by_id(opening_id)` fails → `continue`, no record), :103-109 (opening mesh build `Err(_) => continue` / empty → `continue`, no record — a window silently not cut), rust/geometry/src/router/voids/probe.rs:519 (`let Ok(item_parts) = … else { continue }`), rust/geometry/src/router/layers.rs:63-75 (recorded in `layer_slice_diag` only), rust/processing/src/element.rs:420 (`let _ = router.take_csg_failures()` discards the abandoned attempt's records by design, documented). Error type is `Error::geometry(String)` throughout; 40+ distinct message strings, none matchable.
- Why it matters: `GeometryDiagnostics` promises "a maintainer can answer why didn't this wall's window get cut from a console log alone" (mod.rs:170-175); an opening whose own body fails to mesh leaves no trace.
- Fix: route the two `continue`s through `record_unsupported_item`/a new `OpeningDiagnostic.kind = Unmeshable`; introduce a `GeometryErrorKind` enum behind `Error::geometry`.
- Effort: S

### ROUTER-38: `#[cfg(feature = "opening-perf-trace")] crate::opening_perf_trace::record(|c| …)` ×21
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/voids/{staged.rs (9), coaxial_union3d.rs (5), batch_cutter.rs (1), prism_cut.rs (5), mod.rs (2)}.
- Fix: `perf_trace!(c => c.field = c.field.saturating_add(1))` macro that expands to nothing without the feature.
- Effort: S

### ROUTER-39: Tautological / copy-pasted compile-time guards
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/processing.rs:1146-1170 (`assert_eq!(super::MAX_MAPPED_ITEM_DEPTH, ifc_lite_core::MAX_MAPPED_ITEM_DEPTH)` — `super::` *is* the import; the test can only fail if someone also adds a shadowing const, which its own doc concedes); rust/geometry/src/router/diagnostics_recording.rs:130-148, :155-170, :175-184 (three `const _: () = { #[allow(dead_code)] fn … { let Struct { a: _, b: _ } = d; } }` blocks).
- Fix: drop the self-equality test (or make it a `scripts/check-*.mjs` grep like the refwalk guard); one `pin_fields!(Struct { a, b, c })` macro.
- Effort: S

### ROUTER-40: Public surface wider than the two real callers need
- Category: Best-practice
- Severity: Low
- Confidence: LIKELY
- Where: rust/geometry/src/router/mod.rs — six constructors (`new`, `with_units`, `with_units_and_rtc`, `with_scale`, `with_scale_and_local_frame`, `with_rtc`, `with_scale_and_rtc`, `with_quality`, `with_scale_and_quality`) plus eight `set_*/enable_*` mutators, while the only production callers (jobs.rs:185-197, batch.rs:178-262, processor/mod.rs:1068-1105) all do `with_scale_and_quality` + a fixed set of `set_/enable_` calls; `pub RectParam`, `pub fn parametric_rect_probe(_all)`, `pub fn get_opening_item_meshes_world`, `pub fn get_opening_item_bounds_with_direction`, `pub fn process_element_with_material_layers`, `pub fn take_bool2d_stats/take_prism_*`, `pub fn set_build_dedup_extra_override`, `pub fn local_frame_set_enabled_override`, `pub fn resolve_scaled_mapped_item_transform_with_origin_loader`.
- Fix: `RouterConfig { unit_scale, quality, rtc, local_frame, skip_small_cuts }` + `SharedCaches { dedup, brep_signatures, mapped, instancing_plan, indexed_colour_ids }` → `GeometryRouter::new(config, caches)`; demote probes to `pub(crate)` after a repo-wide grep.
- Effort: M

### ROUTER-41: Three mesh-identity hashing schemes
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/caching.rs:20 (sampled FxHasher u64), :82 (dual-seeded FxHasher u128), rust/geometry/src/router/content_hash.rs:47-71 (`fold`/`fold_bytes` splitmix 128-bit lanes over STEP bytes), rust/geometry/src/geom_hash.rs (`GeometryHasher`, world-space tolerance hash).
- Fix: after ROUTER-22, keep `compute_mesh_hash_full` and move it to `geom_hash.rs` beside `mix64`; `content_hash::fold` stays (different domain) but should reuse `geom_hash::mix64` only (it does).
- Effort: S

### ROUTER-42: "Is this placement the identity" with three tolerances
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/layers.rs:535 `matrix_is_identity` (1e-9 elementwise, hand loop), rust/geometry/src/router/processing.rs:651 `transform.is_identity(1e-9)` (nalgebra), rust/geometry/src/router/transforms/mapped.rs:129 `m.is_identity(1e-12)`.
- Fix: delete `matrix_is_identity`; one `PLACEMENT_IDENTITY_EPS` in `transform.rs`.
- Effort: S

### ROUTER-43: `enclosing_f32` re-implemented 170 lines below its own import
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/transforms/mesh_world.rs:55-62 (`down`/`up` closures) vs :232 (`enclosing_f32` import) vs rust/geometry/src/router/processing.rs:39 (definition).
- Fix: use `enclosing_f32`.
- Effort: S

### ROUTER-44: Two 24-vertex box builders
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/voids/synthesis.rs:654-691 `make_box_mesh` (axis-aligned, hard-coded normals) vs rust/geometry/src/router/voids/malformed_opening_repair.rs:64-91 `make_obb_mesh` (same face table, derived normals; `extended_box_mesh:46` cites `make_box_mesh`'s corner order).
- Fix: `box_mesh_from_corners(&[Point3;8])`; `make_box_mesh` = corners of an AABB.
- Effort: S

### ROUTER-45: Union-find implemented three times beside `crate::union_find`
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/voids/geom.rs:128-141 (`spatial_cluster_count`), rust/geometry/src/router/voids/sweep.rs:120-127 (`overlapping_components`), rust/geometry/src/router/voids/coaxial_union.rs:204-222 (`coaxial_union_prepass`); crate module rust/geometry/src/union_find.rs.
- Fix: use `crate::union_find`.
- Effort: S

### ROUTER-46: Sutherland–Hodgman plane clip ×4
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/voids/aabb_clip.rs:488-598 (six planes, hand-rolled per-case split; jscpd: aabb_clip.rs:88-104 ↔ csg/mod.rs:479-495), rust/geometry/src/router/voids/prism_cut.rs:1709-1735 (`tri_touches_slab_footprint`, two planes), rust/geometry/src/csg `clip_triangle_with_epsilon` (canonical), `ClippingProcessor::clip_mesh` (used by layers.rs:605-606).
- Fix: `aabb_clip` = fold over `ClippingProcessor::clip_triangle` with the six box planes; `prism_cut` clips with the same helper on `[f64;3]`.
- Effort: S

### ROUTER-47: Magic tolerances without a named home
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where (examples): cosine thresholds 0.98 (geom.rs:704, :785, local_frame.rs:134), 0.985 (exit_cap.rs:35, coaxial_union.rs:624), 0.999 (prism_cut.rs:956), 0.9999 (:990), 0.9/0.2 (local_frame.rs:318, frame_project.rs:25, mod.rs:981); 1 mm pads `BATCH_PAD`, `PAD`, `REFINE_REGION_PAD`, `TOUCH_EPS`, veto `1.0e-3` (prism_cut.rs:2887, :2892) all = 1e-3 but separately named/unnamed; volume-reconcile windows `0.97..1.03` (mod.rs:472, bool2d_path.rs:333), `0.98..1.02` (prism_cut.rs:1111), 5 % (coaxial_union.rs:662), 2 % (coaxial_union.rs:433); 1e-4 "closure grid" in five files; `1.0e-6 * (1.0 + mag)` scale-relative eps spelled 6× in prism_cut.
- Fix: `voids::tol` module with named constants and `fn rel_eps(mag)`; the doc comments justifying each value move with them.
- Effort: S

### ROUTER-48: Geometry-job entity scan triplicated across crates
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/rtc_offset.rs:445-452 (`file_geometry_spans`, comment: "mirroring the entity-job scans in processing/src/processor/mod.rs and wasm-bindings/src/api/gpu_meshes/prepass.rs"), rust/processing/src/processor/mod.rs:719-754, rust/wasm-bindings/src/api/gpu_meshes/prepass.rs:393.
- Fix: `ifc_lite_core::geometry_entity_spans(content)` iterator used by all three.
- Effort: S

### ROUTER-49: Diagnostic enums/structs mirrored
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/diagnostics_recording.rs:189 `OpeningKindDiag` and :390 `ClassificationKind` both "mirror the variants of `OpeningType`" (every `bump(..)` call in synthesis.rs passes both); `ClassificationStats` → `ClassificationSummary` and `RectFastStats` → `RectFastSummary` copied field-by-field at diagnostics.rs:256-263 and :327-336.
- Fix: one `OpeningClass` enum; `impl From<RectFastStats> for RectFastSummary`.
- Effort: S

### ROUTER-50: Test fixtures copy-pasted across the crate
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED (jscpd)
- Where: the wall+opening fixture at rust/geometry/src/router/voids/synthesis_tests.rs:503-528 is duplicated in tests/voids_common/fixtures.rs:81-106, tests/material_layers_test.rs:23-48 and :297-322, tests/issue_1167_rotated_wall_opening.rs:123-147, tests/material_layers_local_frame_test.rs:24-46, tests/opening_void_cut_local_frame_test.rs:56-74; coaxial_union_tests.rs:21-69 ↔ world_frame_fixture.rs:51-99 (49 lines); structural_tests.rs:65-81 ↔ processors/tests.rs:446-477; layers_cycle_tests.rs:1-14 ↔ processors/surface_cycle_tests.rs:1-14; router/tests.rs self-clones at 776-791/1078-1093, 910-925/1135-1150, 940-955/1163-1178, 1087-1102/1108-1123; annotation_tests 71-86/94-109/126-140; batch_cutter_tests 196-208/249-264/305-319/358-371.
- Fix: `crate::test_support::fixtures::{wall_with_opening(..), rotated_wall(..)}` builders; the integration tests import them via `tests/voids_common`.
- Effort: M

### ROUTER-51: Two-tier mapped-item cache with divergent guards
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/router/mapped_item.rs:136-143 (read: shared else RefCell), :309-344 (write: shared guarded on non-empty/budget/truncation, RefCell "deliberately UNGUARDED"), rust/geometry/src/router/diagnostics/unsupported_items.rs:61-64 documents the asymmetry as a feature.
- Why it matters: two code paths, two drop-counting semantics (a total-loss source counts once via the RefCell but once per occurrence via the shared cache — documented at unsupported_items.rs:43-59 as "read the number as a lower bound").
- Fix: one `SourceCache` (always `Arc<Mutex<..>>`, created by the constructor when none injected) with one guard; the per-element RefCell disappears.
- Effort: S

## Concept inventory

Vector/matrix math
- `prism_cut.rs:218-269` `V3/V2` kit: `dot/sub/add/scale/cross/norm/normalize/lerp/bits`
- `voids/geom.rs:14` `extract_rotation_columns`, `:23` `rotate_and_normalize`, `:223` `rotate_point` (FMA-free), `:241` `signed_permutation_map`, `:232` `thin_axis`
- `coaxial_union.rs:542` `ortho_frame`; `prism_cut.rs:744` `basis_from_depth`; `voids/mod.rs:98` `OpeningFrame::from_depth`; `frame_project.rs:21` `wall_frame_from_depth`; `transforms/grid.rs:219` `orient_x_in_plane`, `:232` `left_normal`, `:244` `line_intersection_2d`; `transforms/linear.rs:224` `sample_polyline_at_distance`
- `prism_cut.rs:704` `obb_overlaps` (SAT 15 axes); `aabb_clip.rs:210` `triangle_intersects_box` (SAT 13 axes)
- `frame_parts.rs:34` `frames_mergeable`, `:69` `frame_span`

Transforms / placements
- `transforms/walk.rs:65` `get_placement_transform_with_depth` (memoised, `PlacementWalk{transform,truncated}`), `linear.rs:27`, `grid.rs:28`, `grid_frame.rs:56` `owning_grid_frame`
- `transforms/parsers.rs:16/61/100` `parse_axis2_placement_3d/parse_cartesian_point/parse_direction` (duplicates of `transform.rs:26/134/286`); `mapped.rs:135` `parse_axis2_placement_2d` (delegate); `operator.rs:33` `parse_transformation_operator` (single home), `:234` `parse_direction_ratios`
- `transforms/mapped.rs:61` `mapped_item_transform` (Target·Origin), `:106` `mapping_origin_transform`, `:17/30` `resolve_scaled_mapped_item_transform(_with_origin_loader)`
- `transforms/mod.rs:101` `mat4_to_col_array`, `:109` `mat4_to_row_major`, `:130` `apply_placement`, `:183` `apply_submesh_placement`, `:245` `get_placement_transform_from_element_with_status`, `:267` `resolve_scaled_placement_strict`; `mod.rs:709` `resolve_scaled_placement`, `:676` `scale_mesh`, `:688` `scale_transform`
- `transforms/mesh_world.rs:40` `transform_mesh_local`, `:111` `transform_mesh_world`, `:190` `transform_mesh_world_framed(_impl)`, `:354` `transform_normals` (inverse-transpose), `:158` `needs_local_frame`, `:135` `mapped_origin_needs_local_frame`
- `voids/frame_project.rs:40` `mesh_to_frame`, `:75` `project_aabb_in_frame`; `voids/geom.rs:267` `rotate_mesh_into_frame`, `:296` `rotate_mesh_from_frame`; `malformed_opening_repair.rs:325` `translate_cutter_mesh`; `processing.rs:819` `element_frame_rtc`
- `processing.rs:21` `IDENTITY_ROW_MAJOR`

Tolerances / epsilons (named)
- `voids/mod.rs:44-68` `NORMALIZE_EPSILON=1e-12`, `WALL_NORMAL_DEPTH_COS=0.98`, `MIN_OPENING_VOLUME=1e-4`, `CSG_TRIANGLE_RETENTION_DIVISOR=4`, `MIN_VALID_TRIANGLES=4`, `MIXED_ROUTE_DEFECT_FLOOR/GROWTH`, `MAX_EXTRUSION_EXTRACT_DEPTH=32`, `ENGULF_TOLERANCE(_F32)=0.03`; `:276` `min_opening_volume(quality)`
- `voids/geom.rs:213` `AXIS_THRESHOLD=cos 1°`, `:123` `TOUCH_EPS=1e-3`, `:522` `PULL_TO_CENTROID=0.1`, `:556/559` `PARITY_DIR_A/B`; `prism_cut.rs:1410` `RAY_DIR` (dup of A)
- `synthesis.rs:326` `MERGE_TOLERANCE=0.01`, `:557` `POKE_TOL=1e-6`, `:607` coplanarity pad `1e-5`; `exit_cap.rs:35` `CAP_PARALLEL_COS=0.985`, `:43` `BAND_FRACTION=1e-3`, `:68` `RING_BAND_FRACTION=0.25`; `exit_cap_far_field.rs:25` `EXIT_CAP_FAR_FIELD_THRESHOLD_METERS=10_000`
- `frame_snap.rs:33-44` `QUANTUM_ULPS=4`, `MAX_SNAP_TOLERANCE=1e-4`, `MAX_CLUSTER_SPAN_TOLERANCES=4`, `:49` `frame_snap_tolerance`; `sweep.rs:46` `SWEEP_COST_BUDGET=2e6`, `:233/273` `EPS=5e-5`, `VERTEX_CLEARANCE=1e-3`
- `prism_cut.rs:576` `MAX_PROFILE_VERTS=120`, `:757` `MAX_SLABS=6`, `:1323` `BASIS_TOL`, `:2863` `PROFILE_FUSE_TOL=8·SNAP_GRID`, `:2905` `REFINE_REGION_PAD=1e-3`; `closure_checks.rs:136/137/215` `COLLINEAR_TOL=2`, `T_EPS=1e-6`, `GAP_TOL`; `vertex_dedup.rs:125` `weld_tolerance` (4 ulp)
- `layers.rs:34` `MIN_SLICEABLE_THICKNESS_M=0.002`, `:536` `EPS=1e-9`; `mesh_world.rs:13/18` `LARGE_MAPPED_ORIGIN_M=1000`, `FAR_RTC_FRAME_M=1e6`; `caching.rs:32` `MAX_HASH_ELEMENTS=128`; `content_hash.rs:33-44` `MAX_DEPTH=256`, `CYCLE_SENTINEL`, `FACETED_BREP_TAG`, `:213` `FACETED_BREP_DEDUP_FACE_LIMIT=20_000`; `annotation.rs:12-13` `MAX_VERTICES=2048`, `MAX_RINGS=64`; `coaxial_union.rs:141` `PAD`, `:265` `COAXIAL_DOT_MIN`; `mod.rs:1241` `BATCH_PAD`
- external: `ifc_lite_core::{MAX_MAPPED_ITEM_DEPTH, MAX_PLACEMENT_DEPTH, LARGE_COORD_THRESHOLD_METERS}`, `kernel::mesh_bridge::SNAP_GRID`

Unit conversion
- `mod.rs:297` `scan_unit_scale` (first IFCPROJECT via `extract_length_unit_scale`), `:646` `unit_scale`; `rtc_offset.rs:38` `rtc_offset_from_translations` (median), `:376/432` `detect_rtc_anchor/offset_for_file`; `raw_coordinate.rs:12/54` `representation_item_first_vertex_meters`, `representation_item_benefits_from_rtc`; `processing.rs:923` `raw_item_rtc_file_units`

Bbox / AABB
- `frame_parts.rs:78` `mesh_bounds` (`[f32;6]`), `:96` `union_bounds`; `processing.rs:39` `enclosing_f32`, `:56` `publish_object_frame_bounds`; `malformed_opening_repair.rs:303` `world_host_bounds`; `voids/geom.rs:667` `extent_along_axis`, `:343` `volume_reference`; `coaxial_union.rs:529` `aabb_overlap`; `prism_cut.rs:322` `PTri::aabb`; `synthesis.rs:435` `extend_opening_along_direction`; `geom.rs:36/64/102` `wall_thinnest_axis_dir`, `infer_box_penetration_dir`, `opening_mesh_thinnest_axis_dir`

Hashing
- `caching.rs:20` `compute_mesh_hash` (sampled u64), `:82` `compute_mesh_hash_full` (u128), `:163` `meshes_equal`, `:130` `get_or_cache_by_hash`
- `content_hash.rs:47` `fold`, `:58` `fold_bytes`, `:78` `type_token_is`, `:112` `parse_first_ref`, `:159` `try_faceted_brep_signature`, `:243` `item_signature`, `:266` `key_with_params`, `:274` `sig_entity`, `:332` `sig_walk_bytes`; `brep_signatures.rs:45` `item_dedup_key_in_frame`; `mod.rs:527` `geometry_routing_key`
- `prism_cut.rs:267` `bits`, `:1795` `CrossCache`, `:2123` `PointPool` (tolerance-merged 2D intern)

Triangulation / polygon ops
- `annotation_polygon.rs:12` `triangulate` (plane fit + `triangulation::triangulate_polygon_with_holes`), `:65-135` `orient/on/intersects/inside/validate`
- `prism_cut.rs:274` `pip`, `:295` `seg_cross_param`, `:764` `simplify_collinear`, `:801` `ccw_area`, `:835` `ring_interior` (via `cdt::triangulate_constrained`), `:853` `cross_section_ring`, `:1289` `rings_equal`, `:1516` `point_in_or_on`, `:1543` `ring_contains_ring`, `:1550` `ring_is_simple`, `:1701` `tri_touches_slab_footprint`, `:2171` `decompose_tri` / `:2667` `cap_cdt_impl` (via `cdt::triangulate_pslg`), `:2574` `resolve_crossings`
- `voids/geom.rs:120` `spatial_cluster_count`, `:166` `mesh_is_closed_exact`, `:394/402` `param_cut_watertight/topology_defect_count`, `:443` `ray_triangle_param`, `:474` `axis_line_crosses_mesh`, `:512` `opening_redundant_with_host`, `:547/585` `point_inside_mesh(_agreed)`, `:602` `opening_engulfs_host_solid`, `:652` `mesh_vertex_centroid`, `:688` `is_rectangular_box_mesh`, `:766` `infer_opening_frame`
- `synthesis.rs:325` `merge_rectangular_openings`, `:654` `make_box_mesh`, `:718` `extend_opening_mesh_through_host`; `membrane.rs:39` `remove_internal_membrane`; `exit_cap.rs:282` `detect`; `malformed_opening_repair.rs:64` `make_obb_mesh`, `:101` `cutter_is_closed_manifold`, `:136` `opening_obb_if_malformed` (PCA), `:272` `recut_malformed_openings`
- `sweep.rs:29` `mesh_to_keep`, `:51` `point_mesh_distance_exceeds` (Ericson closest point), `:118` `overlapping_components`, `:217` `drop_faces_outside_host`; `frame_snap.rs:93` `snap_to_frame_planes`, `:150/159` `closed_and_consistently_wound/closed_as_emitted`, `:190` `enclosed_volume`
- `closure_checks.rs:27` `ClosureVerdict`, `:78` `directed_closed`, `:91/96` `closed_or_hairline/closed_enough_to_emit`, `:338` `edge_multiplicity_defects`; `vertex_dedup.rs:31` `dedup_cut_vertices`; `tjunction_close.rs:32` `close_seams`; `finish.rs:26` `finish_cut_verdict`; `planar_correction.rs:16` `correct_planar_overlap`
- `aabb_clip.rs:63` `cut_rectangular_opening_no_faces`, `:395` `clip_triangle_against_box`; `layers.rs:304` `merge_thin_layers`, `:556` `slice_mesh_into_layers`; `coaxial_union.rs:577` `cutter_footprint`, `:322` `build_coaxial_prisms`; `bool2d_path/footprint.rs:23/38` `footprint_interior/opening_solid_footprint`; `bool2d_path.rs:313` `reconcile_solid`

Entity attribute access / decoding
- `rep_filter.rs:22/44/55/97/109` `is_body_representation`, `is_direct_body_representation`, `meshed_representations`, `effective_rep_type`, `effective_element_rep_type`; `annotation.rs:15/25` `accepts/is_fill_only_representation`; `structural.rs:24` `accepts`; `rtc_offset.rs:30` `is_rtc_votable_representation`, `:445` `file_geometry_spans`
- `probe.rs:142` `read_rect_profile_2d`, `:253` `body_representation_items`, `:302` `rect_param_from_item`, `:712` `extruded_solid_from_item`, `:795/813` `host_extruded_solid/opening_extruded_solids`, `:40/75` extrusion-direction extractors; `representation.rs:13` `opening_requires_subtraction`; `layers.rs:365/436/483/512` single-item / identity-position predicates; `instancing.rs:25` `mapped_source_single_item`; `annotation.rs:92` `read_ring`; `annotation_style.rs:10` `validate`; `grid_frame.rs:35` `GridPlacementLayout::of` (schema-aware attribute indices — the only data-driven attribute lookup in the module)

Colour / style resolution
- none in the router by design (`annotation_style.rs` validates only; `is_indexed_colour_split_source` mod.rs:458 is a set lookup)

Error types / diagnostics
- `crate::Error::geometry(String)` everywhere (no enum); `annotation.rs:139` `invalid(reason)`; `BoolFailure`/`BoolFailureReason` from `crate::diagnostics`; `diagnostics.rs:155` `GeometryDiagnostics` (+ `ClassificationSummary`, `ReasonCount`, `RectFastSummary`, `HostBbox`, `WorstHost`, `GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION=3`), `:243` `aggregate_diagnostics`; `diagnostics_recording.rs:26/44/97/189/390` `ClassificationStats`, `HostOpeningDiagnostic`, `OpeningDiagnostic`, `OpeningKindDiag`, `ClassificationKind`; `diagnostics/attribution.rs:18/29` `UNATTRIBUTED_PRODUCT_ID`, `count_attributed_products`; `diagnostics/unsupported_items.rs:20` `UnsupportedItemState`, `:94` `enter_unsupported_source` (RAII scope), `:115` `record_unsupported_item`, `:166/176` `format_unsupported_breakdown/summarize`; `processor.rs:17` `GeometryProcessor` trait (`process`, `process_in_rtc_frame`, `take_bool_failures`, `bool_failure_count`, `truncate_bool_failures_to`); `item_dedup_cache.rs:43` `ItemDedupCacheState{meshes, diagnostic_claimed}`; `staged.rs:67` `HostAttempt`, `frame_snap.rs:215` `HostDiagSnapshot`; `prism_cut.rs:103-212` feature-gated `diag` counters; `bool2d_path.rs:62` process-global `FIRES/FOOTPRINTS`

## Target shape

Opinionated sketch; sizes are for the non-test code (~21k lines today → roughly 12–14k).

1. **Split `GeometryRouter` into three owned things instead of a 30-field god struct.**
   - `RouterConfig` (immutable per build): `schema: &'static IfcSchema`, `unit_scale`, `rtc_offset`, `quality`, `local_frame: Option<bool>`, `skip_small_cuts`, `instancing: Option<InstancingMode>`. One constructor, no `with_*` ladder.
   - `SharedCaches` (one `Arc`, injected whole): item-dedup, brep signatures, mapped-source meshes, instancing plan, indexed-colour ids. The per-router `RefCell` fallbacks disappear (ROUTER-51, -22).
   - `RouterDiagnostics` (one struct with `snapshot()/restore()`, `drain() -> DrainedDiagnostics`): CSG failures, classification, host openings, rect/bool2d/prism/coaxial path stats, unsupported items, layer-slice diag. All request-local; no process-global atomics (ROUTER-18).
   - `GeometryRouter { config, caches, diag, processors: ProcessorRegistry }`.

2. **One representation walk.** `rep_filter::body_items(element) -> impl Iterator<Item = (ShapeRep, Vec<Item>)>` is the only code that reads attributes 6/2/3; RTC detection, layers, probes, routing key and the two element paths all consume it (ROUTER-1).

3. **One item pipeline.** `ItemMesher::mesh(&self, item: &DecodedEntity, frame: Frame) -> Result<ItemParts>` wraps registry lookup → dedup key → RTC rebase (`process_in_rtc_frame`) → `validate_indices` → scale → hash/stamp → cache. `MappedSource::walk(&self, map, sink)` is the single mapped-source walk and calls `ItemMesher::mesh`, never a processor directly; `collect_submeshes`, `process_mapped_item_cached`, `ensure_shared_mapped_source` and the type-geometry path are sinks (ROUTER-2, -26, -27). `process_element_parts` and `process_element_with_submeshes_impl` become one function parameterised by an `ItemSink` (merge-into-frames vs push-sub-mesh), killing the duplicated element walk.

4. **Data-driven dispatch.** `const BUILTINS: &[Builtin]` is the only processor table; `IfcType::geometry_family()` (brep / tessellated / surface-model / swept / boolean / face / curve) replaces every hand `matches!` (ROUTER-34, -35). The registry becomes `[OnceCell<Rc<dyn GeometryProcessor>>; BUILTINS.len()]` + an `FxHashMap` override.

5. **Placement = `crate::transform`.** The router keeps only the memoised placement *walk* (`walk.rs`, `linear.rs`, `grid.rs`); all leaf parsing delegates to `transform.rs` (ROUTER-3, -14, -16). `element_world_placement(strict)` is the one resolver behind `apply_placement`, `apply_submesh_placement`, `resolve_scaled_placement(_strict)`, `element_frame_rtc` and the probes (ROUTER-15).

6. **Voids as a strategy list.** Replace `apply_void_context` / `_inner` with:
   ```rust
   struct Cutter { .. }                       // ROUTER-32
   struct OpeningSet { cutters: Vec<Cutter>, merged: Vec<Cutter> }   // built once per host from memoised OpeningGeometry (ROUTER-21)
   trait CutStrategy { fn name(&self) -> &'static str; fn try_cut(&self, host: &Mesh, set: &OpeningSet, cx: &mut CutCx) -> CutOutcome; }
   enum CutOutcome { Cut { mesh: Mesh, residual: Option<OpeningSet> }, Defer }
   const STRATEGIES: [&dyn CutStrategy] = [ParamRect, Bool2d, Prism, WallLocalFrame, RectFast, CoaxialUnion, DisjointBatch, SequentialExact /* with #635 fallback, engulf, redundant guards */];
   const POST: [&dyn PostPass] = [SliverRefine, MalformedRecut, FlapClip, ShardSweep, CutEffectDiag];
   ```
   `apply_void_context` = `for s in STRATEGIES { match s.try_cut(..) { Cut{mesh, residual: None} => return post(mesh), Cut{mesh, Some(r)} => { host = mesh; set = r } , Defer => {} } }`. Admission, engulf, acceptance and the through-host extension memo live in `voids::admission` (ROUTER-10, -20). Each strategy file is ≤ 600 lines; `apply_void_context_inner` ceases to exist (ROUTER-33).

7. **Mesh-topology kit in `mesh.rs` / `mesh_tjunction.rs`, not in voids.** `EdgeLedger` (ROUTER-5), `Mesh::signed_volume(_about)`, `surface_area` (ROUTER-6), `bounds_f64/world_bounds` (ROUTER-11), `rebuilt_like` everywhere (ROUTER-12), `vertex(i) -> Option` (ROUTER-31). 2D ops in `geom2d.rs` only (ROUTER-7); one Möller–Trumbore + one parity direction in `geom.rs` (ROUTER-8).

8. **Flags and tolerances.** `EnvFlag` statics (ROUTER-17) and a `voids::tol` module (ROUTER-47). Perf-trace via a macro (ROUTER-38).

9. **Delete.** `geometry_hash_cache` + sampled hash (ROUTER-22); the three parser forks (ROUTER-3); `matrix_is_identity`, `enclosed_volume`, `make_obb_mesh`'s twin, the three union-finds, the `down/up` closures, `HostAttempt`, `ClassificationKind`, the self-equality test.
