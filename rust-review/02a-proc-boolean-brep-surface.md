# PROC sub-area review: boolean/, advanced_face/, advanced.rs, brep/, surface.rs, structural_edge.rs, structural_face.rs

This is a read-only review: no cargo was run and no files were edited. The IDs use the prefix `PROC-S`, so the lead can renumber them without collisions. All paths are relative to the repo root.

## Summary
- **Three separate IFC curve samplers, and they have drifted.** The copies are `ProfileProcessor` (profiles/), advanced_face/{polyline,edge_loop,conics,curves}.rs, and surface.rs. The copies in this sub-area are missing behaviour the canonical one has: parameter trims, IfcIndexedPolyCurve, rational/ellipse trimmed bases and 2D placements. The result is wrong geometry: a full circle where an arc was authored, a polygonal-bounded half-space (PBHS) cutter that over-cuts, and a circle sampled in the wrong plane.
- **Confirmed bug: a spurious point at the world origin on B-spline curves.** `polyline.rs:117-128` evaluates the curve exactly at `t_max`. With the half-open Cox–de Boor table and a clamped knot vector, every basis function is 0 there, so the point appended is `(0,0,0)`. This adds spikes to surface-of-revolution profiles and to composite-curve edges in advanced faces.
- **Two processors are never registered with the router.** `IfcFacetedBrepWithVoids` has no processor, although the RTC and layers code expects one. `SurfaceOfLinearExtrusionProcessor` is public and documented but missing from the registry, so it is dead in the pipeline.
- **Face-bound extraction exists 3 times, and so does planar-face triangulation, with real behaviour differences.**
  - When no bound is an `IfcFaceOuterBound`, faceted.rs and surface_model.rs take the first bound as outer, but bounds.rs takes the largest.
  - Concave quads are always fanned across the 0–2 diagonal, which gives a wrong triangulation when the reflex vertex is 1 or 3.
  - FacetedBrep, when hole triangulation fails, fans the outer ring and drops the holes. The advanced-face path forbids exactly this, and a test pins that rule.
- **The same small helpers are copy-pasted many times:** reading `(x,y,z)` from a coordinate list (14 sites in this sub-area), STEP boolean parsing (11), placement parsing (4 forks), the Newell normal, the perpendicular-basis fallback, signed area / point-in-ring, `Mesh{..}` literals (6), index-offset appends (4), and `process`/`process_in_rtc_frame` boilerplate (6).
- **Boolean issues.**
  - A malformed half-space returns `Err` through `?`, which deletes the host element. Every other failure keeps the host uncut.
  - `IfcBoxedHalfSpace` is treated as an unsupported operand.
  - The PBHS boundary only accepts `IfcPolyline`.
  - Several tolerances are absolute file-unit floors, and the comments that justify them assume metres.
- **Stale documentation.** Several comments describe deleted kernels (BSP, Manifold), the wrong file paths, or behaviour that contradicts the code next to them.

## Findings

### PROC-S1: Three independent IFC curve samplers that have drifted (plus a polyline-only PBHS boundary parser)
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - Canonical: rust/geometry/src/profiles/mod.rs:326 `process_curve` (2D) and :376 `get_curve_points` (3D, public; used by alignment.rs:387 and :406); profiles/curves_3d.rs; profiles/curves_2d.rs:70 `process_trimmed_conic`.
  - Copy A (3D, used by advanced faces):
    - rust/geometry/src/processors/advanced_face/polyline.rs:58-306 `sample_curve_polyline_guarded`
    - edge_loop.rs:155-239 `sample_edge_geometry`, :244 `sample_composite_curve_edge`, :289 `sample_polyline_edge`
    - conics.rs:93 and :165
    - curves.rs:98
  - Copy B (2D profile for IfcSurfaceOfLinearExtrusion): rust/geometry/src/processors/surface.rs:142-354, with `curve_walk.rs`.
  - Copy C (PBHS boundary): rust/geometry/src/processors/boolean/polygonal_prism.rs:14-67 `parse_polygonal_boundary_2d`.
- What: Each copy supports a different set of curve types and options.
  - polyline.rs `IFCTRIMMEDCURVE` (228-304) reads only Cartesian trims (`read_trim_point`). Parameter trims (`IFCPARAMETERVALUE`, the IFC4 norm) fall through to `sample_curve_polyline_guarded(&basis)`, which samples the full circle (170-188) or full ellipse (207-227). Its basis match at 276 handles only `IFCBSPLINECURVEWITHKNOTS`, not the rational variant; edge_loop.rs:207 handles both.
  - The test `polyline_cycle_tests.rs:86` passes only because a parameter-trimmed `IfcLine` falls back to the raw line.
  - surface.rs handles only IfcPolyline and IfcCompositeCurve. Any other curve type goes through `get_polyloop_point_ids_fast` on raw bytes (251), which reads the first nested list: a B-spline's control polygon, or a trimmed curve's Trim1 list.
  - polygonal_prism.rs:19 rejects anything that is not IfcPolyline, so an IFC4 `IfcIndexedPolyCurve` or composite boundary errors. See PROC-S18 for the over-cut this causes.
  - surface.rs's `CurveWalk`/`MAX_CURVE_NODES` duplicates profiles/mod.rs:53 and the `spend_curve_node` at profiles/mod.rs:105.
- Why it matters: Composite curves of parameter-trimmed arcs are common in IFC4. Through `sample_composite_curve_edge`, each segment becomes a full circle inserted into an advanced-face boundary loop. A surface-of-revolution generator profile becomes a full circle instead of an arc. Every fix (#1661, #2866, #605, ISSUE_159) has had to be applied per copy.
- Fix:
  - Make a single 3D curve sampler, `ProfileProcessor::get_curve_points`, or a free `curve_sampler` module extracted from profiles/. Expose a 2D projection variant (`pub(crate) fn process_curve`).
  - Advanced-face edges keep only their edge-specific orient/trim step (`orient_and_trim_edge_polyline`).
  - surface.rs should call `ProfileProcessor::process` on its SweptCurve, which is an IfcProfileDef.
  - The PBHS boundary should use `process_curve`.
- Effort: L

### PROC-S2: Spurious `(0,0,0)` point appended to every clamped B-spline sampled by `sample_curve_polyline`
- Category: Bug
- Severity: High
- Confidence: CONFIRMED (by code reading)
- Where:
  - rust/geometry/src/processors/advanced_face/polyline.rs:117-128
  - evaluator: advanced_face/bspline.rs:18-61 (level 0 at :28: `knots[i] <= u && u < knots[i + 1]`) and :227-246
- What: `t_max = knots[len - degree - 1]` is evaluated exactly, and the result is pushed as `p_end`. For a clamped knot vector (end multiplicity degree+1, the normal case), no half-open span contains `u == t_max`, so every basis value is 0 and `evaluate_bspline_curve` returns the origin. The `near_dup` check compares that origin with the last sample, finds no match, and pushes it. The sampling loop elsewhere avoids this by clamping to `t_hi - 1e-6` (curves.rs:189, bspline.rs:176,189), but this endpoint path does not.
- Why it matters:
  - Surface-of-revolution faces with a B-spline generator (revolution.rs:77-82) revolve a vertex at the origin, producing long spikes.
  - `sample_composite_curve_edge` (edge_loop.rs:268) inserts the origin into face loops wherever a composite segment is a B-spline.
  - No test covers `u ==` the last knot; the partition test at bspline_tests.rs:14 stops at 2.5.
- Fix: Evaluate the end at the last control point when the end knot multiplicity is ≥ degree+1, or treat the last non-empty span as closed (`u <= knots[i+1]` when `knots[i+1] == t_max`) inside `bspline_basis_table`. Add a regression test that `evaluate_bspline_curve(t_max)` equals the last control point.
- Effort: S

### PROC-S3: Face-bound classification and loop extraction exist 3 times with different outer-ring rules
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - rust/geometry/src/processors/brep/faceted.rs:297-327
  - rust/geometry/src/processors/brep/surface_model.rs:98-136
  - rust/geometry/src/processors/advanced_face/bounds.rs:19-83
  - Loop readers: faceted.rs:37-75 (dead decode fallback), :81-102 (`get_polyloop_coords_cached`), helpers.rs:149 `extract_loop_points_by_id` (uncached), bounds.rs:44-50 (dispatch on PolyLoop/EdgeLoop)
- What:
  - **Outer selection without an `IfcFaceOuterBound`:**
    - faceted.rs and surface_model.rs take the first bound as outer.
    - bounds.rs takes the largest projected area, with a deterministic tie-break (bounds.rs:72-81).
  - **Loop types:** surface_model.rs's simple-face branch reads every loop with the PolyLoop-only fast path. An `IfcFace` bounded by an `IfcEdgeLoop` (allowed, since `IfcFaceBound.Bound` is any `IfcLoop`) therefore resolves no points (`parse_cartesian_point_inline` on IfcOrientedEdge bytes returns `None`), and the face is silently dropped. bounds.rs handles edge loops.
  - **Perf:** surface_model uses the uncached reader while faceted uses the decoder's point cache.
  - surfaces.rs:31 still claims it "mirrors the FacetedBrep path … pick the outer (or first) bound", which is no longer true.
- Why it matters: An `IfcFaceBound`-only face (common; OuterBound is optional) whose hole is listed first gets the hole as its outer ring in faceted Breps and surface models. That leads to either garbage triangulation or the PROC-S5 fallback, which fans only the hole. The same face renders correctly through the advanced-face path.
- Fix: Make `bounds::extract_face_bounds` the single home. Give it a fast-path variant that takes `(bound_ids, decoder)` so faceted.rs keeps the raw-byte `get_face_bound_fast` and cached-coordinate path. Delete the two inline loops and the dead `extract_loop_points`.
- Effort: M

### PROC-S4: Planar-face triangulation exists 3 times; the faceted copy's fast paths drifted from `triangulate_polygon`
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - rust/geometry/src/processors/brep/faceted.rs:112-256 `triangulate_face` (tri/quad/convex fast paths 115-189, slow path 191-255)
  - rust/geometry/src/processors/advanced_face/surfaces.rs:34-92 `process_planar_face_rebased` and `triangulate_planar_indices`
  - rust/geometry/src/triangulation.rs:284-321 `triangulate_polygon`, with `quad_indices` :256, `is_convex` :195, `fan_triangulate` :271
- What: Both processors repeat normal → `project_to_2d` → project holes with the same basis → `triangulate_polygon_with_holes` → fan fallback → RTC-subtract f64→f32 position push. The f64→f32 push appears 4 times in faceted.rs alone (117-121, 131-135, 175-179, 238-242). The faceted copy reimplements the triangle, quad and convex fast paths that `triangulate_polygon` already has, and they have drifted:
  - The quad is always fanned 0-1-2 / 0-2-3 (139), whereas `quad_indices` picks the interior diagonal. See PROC-S10.
  - Convexity is tested in 3D with an absolute `1e-10` (162) rather than in 2D.
  - The failure fallbacks differ. See PROC-S5.
- Why it matters: This drift has already produced two bugs (PROC-S5, PROC-S10). Any future degenerate-face fix has to be made in 3 places.
- Fix: Add one `triangulate_planar_face(outer: &[Point3], holes: &[Vec<Point3>], rtc) -> Result<(Vec<f32>, Vec<u32>)>`, for example in triangulation.rs. Keep an optional 3D fast path for triangles and convex n≤8 only if a benchmark shows it matters; otherwise project and call `triangulate_polygon`. Use it from both processors.
- Effort: M

### PROC-S5: FacetedBrep fills authored holes when hole triangulation fails
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/geometry/src/processors/brep/faceted.rs:214-229
  - contrast: advanced_face/surfaces.rs:76-90 and surfaces_tests.rs:99 `failed_hole_triangulation_never_falls_back_to_a_filled_outer_fan`
- What: On `triangulate_polygon_with_holes` → `Err`, faceted.rs fans `outer_points` and ignores `hole_points`. The planar advanced-face path explicitly refuses this ("never valid when holes exist: filling only the outer fan would silently close authored openings") and returns `Err`.
- Why it matters: Faceted Breps and surface models (which use the same function) render solid panes over windows and openings whenever earcut fails. The fan is also wrong for concave outers.
- Fix: Covered by PROC-S4. Until then, copy the `holes_2d.is_empty()` guard and return an empty face, with a diag record, when holes exist.
- Effort: S

### PROC-S6: `IfcFacetedBrepWithVoids` has no processor, and `SurfaceOfLinearExtrusionProcessor` is never registered
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - rust/geometry/src/router/processor_registry.rs:23-70: `TYPES`/`slot` list `IfcAdvancedBrepWithVoids` but neither `IfcFacetedBrepWithVoids` nor `IfcSurfaceOfLinearExtrusion`
  - rust/geometry/src/processors/brep/faceted.rs:408-410 (`supported_types` = `[IfcFacetedBrep]`)
  - rust/geometry/src/processors/surface.rs:137-139
  - expectations elsewhere: router/rtc_offset/raw_coordinate.rs:19, router/rtc_offset.rs:241, router/layers.rs:497
  - docs/api/rust.md:526 and the CHANGELOGs advertise SurfaceOfLinearExtrusionProcessor
- What: `builtin_processor(IfcFacetedBrepWithVoids)` returns `None`, so the item is unsupported, even though FacetedBrepProcessor reads only attribute 0 (Outer), which is identical for the subtype. SurfaceOfLinearExtrusionProcessor is reachable only through the public API and its own tests.
- Why it matters: IFC2x3 hollow faceted solids render nothing, while the RTC detector and layer code treat them as handled. Surface3D items using IfcSurfaceOfLinearExtrusion are dropped, contrary to the documentation.
- Fix: Add `IfcFacetedBrepWithVoids` to slot 4 and to `FacetedBrepProcessor::supported_types`. Either register SurfaceOfLinearExtrusionProcessor (after fixing PROC-S1 and PROC-S23) or delete and unexport it.
- Effort: S

### PROC-S7: Four forks of IfcAxis2Placement/IfcAxis1Placement parsing; the conics fork bypasses `build_axis2_matrix` and misreads 2D placements
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED (the 2D misread is LIKELY in practice)
- Where:
  - rust/geometry/src/processors/advanced_face/conics.rs:13-87 `read_axis2_placement_3d`, used at conics.rs:114 and :190, polyline.rs:179 and :218
  - rust/geometry/src/processors/helpers.rs:31 `parse_axis2_placement_3d` and :171 `get_axis2_placement_transform_by_id`, used at boolean/mod.rs:155, polygonal_prism.rs:99, surfaces.rs:226, surface.rs:55
  - canonical: rust/geometry/src/transform.rs:26, :78 `build_axis2_matrix`, :233; profiles/curves_3d.rs:76 (checks 2D vs 3D)
  - Axis1: advanced_face/revolution.rs:42-70 vs processors/swept/revolved.rs:88-125
- What:
  - The transform.rs:66-77 doc says every Axis2 parser "shares only this orthonormalization… so the guard can never drift out of a fork". conics.rs does its own Gram–Schmidt with a different degenerate fallback (52-56, 61-84: smallest-|dot| basis instead of Z×z / X×z).
  - conics.rs claims "(or 2D)" but always reads attribute 1 as Axis. For an `IfcAxis2Placement2D` with an explicit RefDirection (1,0), axis_z becomes (1,0,0), and the circle or ellipse is sampled in the YZ plane. Profile curves of a surface of revolution are 2D curves, so they normally carry 2D placements.
  - helpers.rs duplicates transform.rs. The by-id variant silently defaults when refs are unresolvable, where transform.rs returns `Err`.
  - The Axis1 copies differ: revolution.rs defaults missing ratios to 0 and swallows errors; revolved.rs defaults y to 1.0 and errors.
- Why it matters: Wrong-plane arcs. The placement rules diverge silently between curve, boolean and surface processors.
- Fix: Use one placement API in transform.rs that returns `(origin, x, y, z)` from either a 2D or 3D placement and always goes through `build_axis2_matrix`. Add a shared `parse_axis1_placement`. Delete conics::`read_axis2_placement_3d` and the helpers.rs duplicates.
- Effort: M

### PROC-S8: Copy-pasted vector/2D-polygon primitives: Newell normal, perpendicular basis, signed area, point-in-ring
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Newell: boolean/polygonal_prism.rs:69-82 vs triangulation.rs:482-528
  - Perpendicular fallback: conics.rs:50-84; revolution.rs:91-99; structural_edge.rs:223-230; transform.rs:100-107; triangulation.rs:432-442
  - Signed area / shoelace: halfspace_cap.rs:236-244; bounds.rs:85-95; polygonal_prism.rs:327-333; homes bool2d.rs:201 and geom2d.rs:38
  - Point-in-ring: halfspace_cap.rs:245-259; homes bool2d.rs:241, geom2d.rs:52, triangulation/ring_geom.rs:23
- What: These are identical formulas with different epsilons (1e-12, 1e-10, 1e-9) and different default axes. `calculate_polygon_normal`'s n≤4 fast path takes the cross product of edges (p1−p0) and (p2−p0). For a concave quad whose reflex vertex is 1, that normal is flipped. This is LIKELY to invert the winding of concave planar quads in faceted.rs:191+ and surfaces.rs:47. polygonal_prism.rs probably kept its private Newell for this reason, but nothing documents why.
- Why it matters: Five different "any perpendicular" choices give different but equally valid frames, which matters wherever a frame is visible (ellipse axes, ribbon orientation). There are four area and point-in-ring copies, with the canonical ones in two crate modules.
- Fix: Make `calculate_polygon_normal` always use Newell and delete polygonal_prism::`polygon_normal`. Add a `geom::any_perpendicular(n)` and use it at the 5 sites. Replace the closures with `bool2d::compute_signed_area` / `point_in_contour`.
- Effort: S

### PROC-S9: The `(x,y,z)`-from-coordinate-list read is repeated at 14 sites, and vertex resolution is strict in one place and lenient in another
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - curves.rs:19-22, :135-138
  - conics.rs:23-26, :32-35
  - polyline.rs:100-103, :142-145, :156-159, :199-202, :247-250
  - edge_loop.rs:301-304
  - revolution.rs:48-51, :59-62
  - bspline_parse.rs:71-79
  - polygonal_prism.rs:40-48
  - strict variant: structural_edge.rs:270-323 `resolve_vertex_point`
  - lenient variant: curves.rs:16 `extract_vertex_coords`
  - homes: transform.rs:159 `parse_decoded_cartesian_point`, :186 `parse_cartesian_point_from_id`, `decoder.get_cartesian_point_fast`
- What: Every copy is a `decode_by_id` plus `unwrap_or(0.0)` per component, with no type check and no finiteness check. That is 48 such sites crate-wide. Within `IfcEdgeProcessor`, plain `IfcEdge` goes through the strict reader (type checks, 2D/3D, finite), while `IfcEdgeCurve` (structural_edge.rs:94 → edge_loop.rs:35 → curves.rs:16) goes through the lenient one. The same vertex therefore errors on one path and is defaulted to 0 on the other.
- Why it matters: A malformed point becomes a vertex at (0,0,0) instead of a refusal, which is the #3421 rule in reverse. Every copy also decodes fully instead of using the fast path.
- Fix: Add `transform::point_from_ref(attr|id, decoder) -> Result<Point3>` (fast path first, type and finite checks) and `vertex_point(vertex)` built on it. Replace the 14 sites.
- Effort: S

### PROC-S10: Concave quads are fanned across the wrong diagonal in faceted Breps and surface models
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/processors/brep/faceted.rs:129-141. It also applies to surface models via surface_model.rs:153.
- What: Every hole-free 4-gon gets `[0,1,2, 0,2,3]`. When the reflex vertex is 1 or 3, the 0–2 diagonal lies outside the polygon: one triangle covers the notch with reversed winding and the other spans the hull. `triangulation::quad_indices` (triangulation.rs:256) already chooses the interior diagonal. surface_model.rs:138-146 describes exactly this "fan across the concavity" failure, but only for n>4.
- Why it matters: L-shaped or flashing quads in BReps render as their convex hull, with overlapping triangles.
- Fix: Covered by PROC-S4. Minimal fix: project to 2D and call `quad_indices`, or pick the diagonal via the sign of the 3D cross product against the Newell normal.
- Effort: S

### PROC-S11: STEP boolean/logical parsing is hand-rolled at 11 sites in this sub-area, with different semantics
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `== "T" || == "TRUE"`, default true: advanced_face/mod.rs:45, bounds.rs:57, edge_loop.rs:47, :96, :194, :262, polyline.rs:238, structural_edge.rs:117
  - `!= "F" && != ".F."`, default true: boolean/mod.rs:126, surface.rs:311
  - `trim_matches('.')`: boolean/operand.rs:100
  - elsewhere in the crate: alignment.rs:126 (`== "T"`, default false), sectioned.rs:149, sectioned_positions.rs:133, profiles/mod.rs:573, :645, :709, profiles/directrix.rs:153, tessellated/polygonal.rs:151, profiles/curves_3d.rs:286, texture/mod.rs:190, trimmed_curve.rs:51, analytic/curve.rs:219, :276; processing/src/symbolic/trimmed_curve.rs:77
- What: `.U.` (UNKNOWN logical) evaluates true at some sites and false at others. The `".F."` and `trim_matches` handling is dead, because the parser strips the dots (as the comment at boolean/mod.rs:125 notes).
- Why it matters: Sense, orientation and agreement flags decide geometry orientation, so the same file attribute can mean different things in different processors.
- Fix: Add `AttributeValue::as_logical() -> Option<Option<bool>>` (or `as_bool_or(default)`) in ifc_lite_core and use it everywhere.
- Effort: S

### PROC-S12: Mesh assembly and processor scaffolding copy-pasted per processor
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Full `Mesh { .. }` literals: faceted.rs:357-368, surface_model.rs:168-179, advanced.rs:151-158 and :227-238, surface.rs:127-134, structural_face.rs:38-49 (14 files crate-wide)
  - `base_idx + idx` append loops: faceted.rs:344-355, surface_model.rs:89-95 and :157-161, advanced.rs:110-116
  - `process` + `process_in_rtc_frame` both delegating to `process_rebased(None/Some)`: faceted.rs:386-406 (plus a public `process_with_rtc` at :375 whose only caller is :405), surface_model.rs:215-246 and :270-301 (jscpd clone), advanced.rs:162-187 and :248-276 (jscpd clone), structural_face.rs:59-82
  - Near-identical trace helpers: surface_model.rs:19-27 vs advanced.rs:28-33 (one prints to stderr in debug builds, the other is documented as "must stay silent")
  - FaceBased vs ShellBased processors differ only in `NAMES` and the type
- What: Every new `Mesh` field (the #1474 capture, plane_tags) has had to be added to each literal by hand. The trait gives no way to say "my process is my rebased process with `None`".
- Why it matters: Maintenance cost. A field added with the wrong default in one literal would be a silent placement bug.
- Fix:
  - Add `Mesh::from_buffers(positions, indices, rtc_applied)`.
  - Add a small `MeshAccumulator::append(positions, indices)` (or `extend_offset`).
  - Add a trait helper (e.g. `trait RtcRebased { fn process_rebased(.., Option<rtc>) }` with blanket `process`/`process_in_rtc_frame`).
  - Merge the two surface-model processors into one struct parameterised by type. Make `process_with_rtc` private.
- Effort: M

### PROC-S13: Duplicated tessellation snippets: grid indices, largest-gap angular extent, circle vs ellipse samplers, ribbons
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Quad-grid / strip index generation: bspline.rs:207-219, surfaces.rs:347-362, revolution.rs:213-227, surface.rs:113-125
  - Largest-gap angular extent: surfaces.rs:260-304 vs revolution.rs:110-152 (near-verbatim, including the `1e-6` dedup and span tolerances)
  - Circle vs ellipse arc sampler: conics.rs:93-157 vs :165-230 (jscpd 104-117 / 180-193; the circle is the ellipse with r1=r2)
  - Full circle vs full ellipse: polyline.rs:170-188 vs :207-227 (jscpd)
  - Thin-ribbon builders: structural_edge.rs:135-181 vs processors/alignment.rs:103-130, with different file-unit half-widths (0.1 vs 0.25). The ribbon is 0.1 mm wide in a millimetre-unit model.
- Why it matters: A winding fix made in one grid copy will not reach the others. The angle-extent heuristic has already been patched twice (#674 and the "straddle θ=π" fix).
- Fix:
  - `fn grid_indices(rows, cols) -> Vec<u32>`
  - `fn angular_extent(angles) -> (start, span)`
  - delete the circle sampler in favour of the ellipse one
  - `fn ribbon_mesh(points, frames, half_width)` shared with alignment, with the width derived from the length-unit scale
- Effort: S

### PROC-S14: Boolean module: AABB/diagonal helpers repeated, and tolerances are absolute file-unit floors whose comments assume metres
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - 8-corner AABB: polygonal_prism.rs:199-208 and cut_heuristics.rs:115-124
  - Diagonal: halfspace_cap.rs:85-86, cut_heuristics.rs:95-98, polygonal_prism.rs:209-211, boolean/mod.rs:458-461
  - Manual AABB intersection: mod.rs:363-395
  - Max-dimension: cut_heuristics.rs:72-75
  - Floors: mod.rs:461 `(diag*1e-3).max(1e-4)`, cut_heuristics.rs:107 `(diag*0.001).max(0.001)` (the comment at :102 says "never less than 1 mm"), halfspace_cap.rs:87 `(diag*1e-5).max(1e-6)`, polygonal_prism.rs:224 `+ 1.0`, :55 `1e-9`, :168 `1e-9`
- What: These meshes are in item-local file units (stated at mod.rs:143-147). `decoder.length_unit_scale()` is passed to the clipper (mod.rs:350, 876, 892, 907; single_cutter_gate.rs:81) but not to any of these floors.
- Why it matters: The "1 mm floor" is 1 µm in a millimetre model and 1 mm in a metre model, so behaviour depends on the file's unit. There is no central home for tolerances (no tolerance module exists in the crate).
- Fix: Add an `Aabb` type (or reuse geom_bounds.rs) with `corners()`, `diag()`, `intersect()` and `max_dim()`. Put a boolean-tolerances block (a module of `const`s) in one place, taking `length_unit_scale` so floors are expressed in metres.
- Effort: M

### PROC-S15: Recursion/walk guards reimplemented with different limits and failure semantics
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - polyline.rs:25, :40, :65 (global `HashSet`, depth 32, silently returns an empty `Vec`)
  - surface.rs:146, :195-213 plus curve_walk.rs:17-63 (path-scoped set, depth 32, 100k-node budget, `Err`)
  - profiles/mod.rs:39, :53 (depth 50, budget 100k)
  - structural_edge.rs:36, :80-91 (global set, depth 64, `Err`)
  - boolean/mod.rs:38, :49, operand.rs:42-84 (`OperandPath`)
  - analytic/curve.rs:12-13 (128 / 100k)
- What: There are five depth constants for the same concept (file-supplied curve chains: 32, 32, 50, 64, 128) and two copies of the 100k node budget. On exhaustion some guards return empty and some return `Err`.
- Why it matters: The AGENTS.md "bounding walks" rule is re-derived for each module. A malformed file gives an empty face in one processor and a recorded error in another.
- Fix: Add one `WalkGuard { path: FxHashSet, depth_cap, budget }` with `enter`/`leave`/`charge` in a shared module, and a single named constant for the curve-chain depth.
- Effort: M

### PROC-S16: `SameSense=.F.` flips loop-derived planar triangulations, where the loops already give the face normal
- Category: Bug
- Severity: Medium
- Confidence: LIKELY
- Where: rust/geometry/src/processors/advanced_face/mod.rs:38-57 and :148, applied to `process_planar_face_rebased` results (mod.rs:89-90 and :100-109)
- What: In ISO 10303-42, face bounds are oriented relative to the face's topological normal. SameSense relates the surface normal to that face normal. Planar and boundary-approximation faces derive their winding from the loops, which already encode the face normal; only surface-parameterised tessellations (B-spline, cylinder, surface of revolution) need the flip. No history or test justifies the blanket flip (it has been present since the initial import).
- Why it matters: Advanced Breps with `SameSense=.F.` planar faces get inverted triangles. This is invisible with cull-none rendering, but it breaks normals and shading and gives the closed shell an inconsistent orientation when the Brep is a CSG operand.
- Fix: Apply `apply_same_sense` only to the parametric branches. Add a fixture with a `.F.` planar face and check the outward orientation (signed volume).
- Effort: S

### PROC-S17: A malformed half-space returns `Err` through `?`, which deletes the boolean host
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: rust/geometry/src/processors/boolean/mod.rs:333 (inside the batched attempt), :786, :799; parse at :104-174 (errors on a non-IfcPlane surface, a missing Position, or an unresolvable ref)
- What: Every other operand failure keeps the host uncut and records a `BoolFailure`. operand.rs:189-197 explains that returning `Err` "would delete the host as well". These three `?` do exactly that: the error propagates out of `process_with_depth_inner`, the router drops the item, and the batched path never defers.
- Why it matters: A wall cut by a half-space whose base surface is an `IfcCylindricalSurface`, or whose plane Position is broken, disappears entirely.
- Fix: Map parse failures to `record_failure(Difference, UnsupportedOperand(..))` and `Ok((mesh, false))`. In `try_union_polygonal_chain`, map them to `defer_after(mark)`.
- Effort: S

### PROC-S18: The PBHS boundary accepts only `IfcPolyline`, so other boundaries fall back to an unbounded over-cut
- Category: Bug
- Severity: Medium
- Confidence: LIKELY
- Where: rust/geometry/src/processors/boolean/polygonal_prism.rs:19-24 → mod.rs:797-840
- What: `PolygonalBoundary` is any `IfcBoundedCurve` (IfcIndexedPolyCurve is standard in IFC4 exports). On anything other than IfcPolyline, `build_polygonal_bounded_half_space_mesh` returns `Err`. The step then records `PolygonalBoundedHalfSpaceFallback` and applies the unbounded plane clip, which removes material outside the polygon.
- Why it matters: Walls clipped by roof cutters authored with indexed polycurves are visibly over-cut, even though the failure is recorded.
- Fix: Parse the boundary with the profile curve sampler (PROC-S1).
- Effort: S

### PROC-S19: `IfcBoxedHalfSpace` is treated as an unsupported solid operand
- Category: Quirk
- Severity: Medium
- Confidence: LIKELY
- Where: rust/geometry/src/processors/boolean/mod.rs:783 (`== IfcType::IfcHalfSpaceSolid`), :262; it falls to operand.rs:185-204
- What: `IfcBoxedHalfSpace` is a subtype of IfcHalfSpaceSolid; its Enclosure is only a hint. With an exact type match, the operand goes to `builtin_processor`, gets `None`, and is recorded as `UnsupportedOperand`, so the host renders uncut.
- Why it matters: Cuts in some exporters' output are lost.
- Fix: Use `is_subtype_of(IfcHalfSpaceSolid)`, excluding the PBHS subtype which is checked first.
- Effort: S

### PROC-S20: B-spline advanced faces ignore the face's bounds, so trimmed NURBS faces render as untrimmed patches
- Category: Quirk
- Severity: Medium
- Confidence: CONFIRMED (the code path; how often it matters depends on the fixture)
- Where: rust/geometry/src/processors/advanced_face/mod.rs:91-95 → surfaces.rs:98-206 (`process_bspline_face(&surface, …)` is never given `face`)
- What: The whole knot domain is tessellated. Outer trims and holes are dropped, and nothing in the code documents this as a known approximation (unlike the planar fallback at mod.rs:105-109).
- Why it matters: Patches overdraw neighbouring faces, and holes in NURBS panels are closed.
- Fix: At least document it and record a diagnostic. Better: trim in parameter space using the face loops.
- Effort: L (to fix) / S (to document)

### PROC-S21: Unresolvable points are silently skipped rather than refusing the curve
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - polyline.rs:196-203 (polyline `continue`)
  - edge_loop.rs:298-306 (polyline edge `continue`), :87-90 (an undecodable oriented edge is skipped, so the polygon gets shorter)
  - curves.rs:130-141 and polyline.rs:95-106 (B-spline control points `filter_map`, which shifts indices against the knots)
  - bspline_parse.rs:69-80 (non-ref grid entries skipped, making rows ragged and misaligned with the weights)
- What: These contradict the rule documented in core decoder.rs:540-546, that callers "must refuse the whole loop on a miss rather than skip the point" (#3421), which surface.rs:232-243 and helpers.rs follow.
- Why it matters: A curve missing one control point is a different curve; a loop missing one vertex is a different face. Either is rendered as if it were the authored one.
- Fix: Make these `?`/`collect::<Option<Vec<_>>>()` and refuse the curve or face, using PROC-S9's helper.
- Effort: S

### PROC-S22: Advanced-face dispatch is stringly typed and allocates `to_uppercase()` on already-uppercase strings
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - advanced_face/mod.rs:85-104
  - edge_loop.rs:163-164, :197-198, :358-362
  - polyline.rs:69, :72, :136, :170, :189, :207, :228, :234, :246, :262, :276, :286
  - revolution.rs:74
- What: `IfcType::as_str()` already returns uppercase (core/src/generated/schema.rs:4357), so each call allocates a `String` per face, per edge and per curve just to compare it with string literals.
- Why it matters: This runs in the hot loop of NURBS-heavy models (tens of thousands of edges). Matching on strings also loses the compile-time exhaustiveness that matching on `IfcType` gives.
- Fix: `match surface.ifc_type { IfcType::IfcPlane => …, … }`.
- Effort: S

### PROC-S23: SurfaceOfLinearExtrusion produces NaN on a zero direction and has no RTC hook
- Category: Bug
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/processors/surface.rs:68-73, :89, :95-110; helpers.rs:212-224 (no normalisation)
- What:
  - `IFCDIRECTION((0.,0.,0.))` → `direction.normalize()` → NaN positions.
  - Positions are narrowed with `as f32` without any RTC rebase. The trait doc (router/processor.rs:42-45) says every raw-coordinate processor implements `process_in_rtc_frame`.
  - In practice this is dead code until PROC-S6 is fixed.
- Why it matters: NaN geometry spreads to bounds. Georeferenced models get f32 jitter.
- Fix: `try_normalize` → `Err`. Implement `process_in_rtc_frame`.
- Effort: S

### PROC-S24: Surface of revolution ignores `IfcSweptSurface.Position`
- Category: Bug
- Severity: Low
- Confidence: LIKELY
- Where: rust/geometry/src/processors/advanced_face/revolution.rs:28-70 (reads attributes 0 and 2 only)
- What: SweptCurve and AxisPosition are defined in Position's coordinate system. A non-null Position (optional in IFC4) is never applied. The comment at :31-37 assumes it is "usually null".
- Why it matters: The surface is misplaced whenever an exporter does populate Position.
- Fix: Parse Position via the shared placement API (PROC-S7) and transform the profile and axis.
- Effort: S

### PROC-S25: AdvancedBrep aborts the whole solid when one face fails to decode
- Category: Bug
- Severity: Low
- Confidence: CONFIRMED
- Where: rust/geometry/src/processors/advanced.rs:84 (`decoder.decode_by_id(face_id)?`) vs brep/surface_model.rs:65-68 (`continue`)
- What: The doc comment at advanced.rs:18-20 says it mirrors surface_model's per-face skip, but a face whose reference does not resolve returns `Err` for the whole Brep.
- Why it matters: One dangling face reference drops the entire element.
- Fix: Change it to `continue` and push the face to `empty_faces`.
- Effort: S

### PROC-S26: Hot-path inefficiencies in the face and curve paths
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - edge_loop.rs:27-38 and bounds.rs:37-43: full `decode_by_id`, which returns a deep clone of the cached entity, for every bound, edge and vertex. Each vertex is decoded at least twice per loop (as the end of one edge and the start of the next), and again for the neighbouring face.
  - polyline.rs:87-106: decodes all control points and parses the knots a second time after `sample_bspline_edge_curve` already did.
  - brep/surface_model.rs:114: the uncached loop reader, whereas faceted.rs:89 uses `get_polyloop_coords_cached`.
  - halfspace_cap.rs:70: `std::env::var_os("IFC_LITE_HALFSPACE_CAP_OFF")` read on every cap call (cut_heuristics.rs:56-66 caches its env var in a `OnceLock`).
  - polygonal_prism.rs:285-299: O(n·m) nearest-point remap, although `triangulate_rings` returns the input points unchanged (profile_generic.rs:40-44), so the identity mapping would do.
  - structural_face.rs:27-35: resolves the surface, then `process_advanced_face` resolves it again.
- Why it matters: NURBS-heavy and boolean-heavy models pay repeated decoding and allocation.
- Fix: Use the fast vertex reader (PROC-S9). Return the parsed curve from `sample_bspline_edge_curve`. Cache the env var in a `OnceLock`. Use an identity map in the prism. Pass the resolved surface through.
- Effort: S

### PROC-S27: Stale or self-contradicting documentation
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - advanced_face/surfaces.rs:31: refers to `processors/brep.rs`, which is now brep/faceted.rs, and to "or first" bound (see PROC-S3).
  - advanced_face/bspline_budget.rs:54: `MAX_KNOT_MULTIPLICITY` is described as being in `bspline.rs`; it is in bspline_parse.rs:92.
  - bspline_budget.rs:91-95: says the standalone surface-model processors drain the curve-cap flag; surface_model.rs:72-79 says they deliberately do not.
  - boolean/halfspace_cap.rs:40-42: "exact f32-bit key… without a tolerance grid", while the code at :89-103 uses a tolerance grid and says "NOT exact f32 bits".
  - boolean/mod.rs:739-770: "we follow web-ifc: SEQUENTIAL", while `try_union_polygonal_chain` batches the same chains.
  - References to deleted kernels: BSP at mod.rs:201 and :741-745; Manifold at :361, :863 and cut_heuristics.rs:53.
  - cut_heuristics.rs:102: claims a 1 mm floor (see PROC-S14).
- Why it matters: Readers are pointed at code and behaviour that no longer exist.
- Fix: Update or delete these comments.
- Effort: S

### PROC-S28: God functions and module size
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - boolean/mod.rs: 924 lines (allowlisted at 936)
  - `try_union_polygonal_chain` mod.rs:301-~474 (~170 lines)
  - `apply_boolean_step` :717-911 (~195 lines, about 80 of them comments)
  - `process_with_depth_inner` :549-~650
  - `cap_half_space_clip` halfspace_cap.rs:60-359 (300 lines)
  - `sample_curve_polyline_guarded` polyline.rs:58-306 (250 lines; one if-chain per curve type)
  - `FacetedBrepProcessor::triangulate_face` faceted.rs:112-256
- Why it matters: These are hard to review, and the bound and fallback logic is interleaved with narrative comments.
- Fix: Split `cap_half_space_clip` into weld, boundary-loop and nest/triangulate stages. Split the batched-chain validation into a `ChainValidator`. Turn `sample_curve_polyline` into a match that dispatches to the shared sampler (PROC-S1).
- Effort: M

### PROC-S29: Dead code, an overly wide public API, and redundant guards
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - faceted.rs:35-75: `#[allow(dead_code)] extract_loop_points` with no explanation, which AGENTS.md requires.
  - faceted.rs:375-384: `pub fn process_with_rtc` (one internal caller).
  - bspline.rs:149-156: `u_degree >= u_knots.len()` is already implied by :146, and `len - deg > len` can never be true.
- Why it matters: Clutter, and a public surface that the PyO3/ffi consumers could start relying on.
- Fix: Delete the unused function and the dead guards; make `process_with_rtc` private.
- Effort: S

### PROC-S30: `partial_cmp().unwrap_or(Equal)` in `sort_by` on file-derived angles
- Category: Bug
- Severity: Low
- Confidence: SUSPECT
- Where: advanced_face/surfaces.rs:270, revolution.rs:121 (also conics.rs:76 in `min_by`, which is harmless)
- What: With a NaN angle (non-finite file coordinates passing through the inverse transform), the comparator is not a total order. The pinned nightly's sort implementations may panic on such comparators, and with `panic=abort` that aborts the wasm worker.
- Why it matters: A malformed file could abort the worker instead of producing an error.
- Fix: Use `f64::total_cmp`, or filter out non-finite angles first.
- Effort: S

### PROC-S31: Copy-pasted test fixtures and checks with conflicting semantics
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - STEP wrapper `wrap`/`wrap_ifc`, 8 copies: boolean/chain_cycle_tests.rs:25, advanced_face/polyline_cycle_tests.rs:61, surface_cycle_tests.rs:8 (jscpd with router/layers_cycle_tests.rs:1-14), router/transforms/placement_depth_tests.rs, router/transforms/linear_tests.rs, profiles/curve_fanout_tests.rs, void_index.rs
  - Open-edge counters with three different semantics: test_support.rs:20 (exact bits, count≠2); halfspace_cap_tests.rs:33-60 (10 µm grid, net-signed tally); chain_cycle_tests.rs:281-305, whose doc comment says the net-signed tally "would certify a non-manifold seam watertight"
  - Signed-volume copies: halfspace_cap_tests.rs:62, chain_cycle_tests.rs:330 (and others) vs kernel/mesh_volume.rs:74
  - Tetra/box builders: chain_cycle_tests.rs:473 and polygonal_removal_tests.rs:7, :59
  - Inline PBHS fixture: chain_cycle_tests.rs:1048-1062 ≈ :1241-1255
  - halfspace_cap_tests.rs:39-78 ≈ tests/halfspace_clip_cap_regression.rs:71-107
- Why it matters: The halfspace_cap watertightness assertions use the instrument that chain_cycle_tests documents as unsound.
- Fix: Move `wrap_step`, `open_edges` (the per-direction incidence version) and `signed_volume` into test_support.rs, and use `kernel::mesh_volume`.
- Effort: S

### PROC-S32: Magic point-coincidence and parameter tolerances scattered through curve sampling
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - squared distance `< 1e-12`: curves.rs:194, edge_loop.rs:277
  - squared distance `< 1e-18`: polyline.rs:124
  - `SEAM_EPS 1e-9` (per axis): curve_walk.rs:14
  - absolute parameter clamp `1e-6`: curves.rs:189, bspline.rs:176 and :189
  - trim span `1e-12`: curves.rs:169
  - basis/denominator `1e-10`: bspline.rs:41, :47, :101, :115, :239
  - circle coincidence: conics.rs:131 and :206
  - angle dedup and span `1e-6`: surfaces.rs:271 and :299, revolution.rs:122 and :146
- What: "Same point" means different things in each place. The parameter clamp is absolute, so a knot span narrower than 1e-6 collapses to `t_min`.
- Why it matters: Behaviour depends on scale and parameterisation.
- Fix: Use named constants in one module, with the parameter clamp relative to `(t_max - t_min)`.
- Effort: S

## Concept inventory

**Vector/matrix math**
- `polygon_normal` (Newell) — rust/geometry/src/processors/boolean/polygonal_prism.rs:69
- `stable_unit_direction` — rust/geometry/src/processors/structural_edge.rs:183
- `transported_frame` — structural_edge.rs:200
- `perpendicular` — structural_edge.rs:223
- `join_offset` / `join_normal` (miter) — structural_edge.rs:232 / :255
- perpendicular-basis build (inline) — advanced_face/revolution.rs:91-99
- perpendicular-basis build (inline) — advanced_face/conics.rs:50-84
- `bspline_basis_table` — advanced_face/bspline.rs:18
- `surface_basis` — bspline.rs:77
- `evaluate_bspline_surface` — bspline.rs:88
- `evaluate_bspline_curve` — bspline.rs:227
- `projected_area` — advanced_face/bounds.rs:85
- `compare_ring_key` — bounds.rs:97

**Transforms/placements**
- `read_axis2_placement_3d` (fork) — advanced_face/conics.rs:13
- Axis1Placement parse (inline) — revolution.rs:42-70
- `parse_half_space_solid` (plane from IfcPlane.Position) — boolean/mod.rs:104
- frame columns from matrix (inline) — polygonal_prism.rs:110-120
- cylinder world↔local via `try_inverse` — advanced_face/surfaces.rs:247-253
- consumed from outside the sub-area: helpers.rs:31, :171, :212; transform.rs:26, :78, :233

**Tolerances/epsilons/bounds**
- `PAR_FACE_THRESHOLD` — brep/faceted.rs:18
- `MAX_BSPLINE_DEGREE` — advanced_face/bspline_budget.rs:62
- `MAX_BSPLINE_SURFACE_SAMPLE_WORK` — bspline_budget.rs:69
- `MAX_BSPLINE_CURVE_CONTROL_POINTS` — bspline_budget.rs:75
- `MAX_KNOT_MULTIPLICITY` — bspline_parse.rs:92
- `MAX_EXPANDED_KNOTS` — bspline_parse.rs:98
- `MAX_CACHED_BASIS_ENTRIES` — bspline.rs:171
- `MAX_BASIS_CURVE_DEPTH` — polyline.rs:40
- `MAX_CURVE_NESTING_DEPTH` — surface.rs:146
- `SEAM_EPS`, `MAX_CURVE_NODES` — curve_walk.rs:14, :17
- `RIBBON_HALF_WIDTH_FILE_UNITS` — structural_edge.rs:24
- `PARALLEL_EPSILON` — structural_edge.rs:32
- `MAX_EDGE_REFERENCE_DEPTH` — structural_edge.rs:36
- `MAX_BOOLEAN_DEPTH` — boolean/mod.rs:38
- `MAX_OPERAND_PATH_NODES` — boolean/mod.rs:49
- `MAX_OPERAND_VISITS` — boolean/operand.rs:42
- `on_plane_eps` / `weld_eps` — halfspace_cap.rs:87, :102
- coincidence `tol` — cut_heuristics.rs:107
- under-removal `tol` — boolean/mod.rs:461
- `fast_cut_skip_ratio` (env `IFC_LITE_FAST_CUT_RATIO`) — cut_heuristics.rs:56
- env `IFC_LITE_HALFSPACE_CAP_OFF` — halfspace_cap.rs:70

**Unit conversion**
- No helper defined in the sub-area.
- `ClippingProcessor::with_unit_scale(decoder.length_unit_scale())` — boolean/mod.rs:350, :876, :892, :907; single_cutter_gate.rs:81
- "file units" ribbon width — structural_edge.rs:24

**BBox/AABB**
- `cutter_below_skip_ratio` (max-dim) — cut_heuristics.rs:71
- `plane_is_coincident_with_host_face` (8 corners, diagonal) — cut_heuristics.rs:87
- host corners and diagonal (inline) — polygonal_prism.rs:198-211
- tight-bounds intersection (inline) — boolean/mod.rs:363-395
- mesh diagonal (inline) — halfspace_cap.rs:84-86
- `RemovalBound` (volume bound) — boolean/polygonal_removal.rs:14

**Hashing**
- quantised weld map `HashMap<(i64,i64,i64),u32>` — halfspace_cap.rs:103-130
- half-edge `HashSet` / `next` map — halfspace_cap.rs:135-165
- `OperandPath` (`FxHashSet`) — boolean/operand.rs:54
- visited sets — polyline.rs:25, structural_edge.rs:60, boolean/mod.rs:239, :574
- `CurveWalk` — curve_walk.rs:28

**Triangulation/polygon ops**
- `FacetedBrepProcessor::triangulate_face` — brep/faceted.rs:112
- `FaceData` / `FaceResult` — processors/helpers.rs:15, :21
- `process_planar_face_rebased` — advanced_face/surfaces.rs:34
- `triangulate_planar_indices` — surfaces.rs:67
- `extract_face_bounds` / `FaceBounds` — advanced_face/bounds.rs:19 / :14
- `tessellate_bspline_surface` — bspline.rs:125
- `process_cylindrical_face` — surfaces.rs:209
- `process_surface_of_revolution_face` — revolution.rs:18
- `cap_half_space_clip` (+ `signed_area`, `point_in_ring` closures) — halfspace_cap.rs:60 (:236, :245)
- `build_polygonal_bounded_half_space_mesh` — polygonal_prism.rs:84
- `build_tilted_prism_mesh` (+ shoelace) — polygonal_prism.rs:260 (:327)
- `ribbon_mesh` — structural_edge.rs:135
- `orient_and_trim_edge_polyline` — edge_loop.rs:314
- `sample_circle_edge_curve` / `sample_ellipse_edge_curve` — conics.rs:93 / :165
- `sample_bspline_edge_curve(_range)` — curves.rs:83 / :98
- `sample_curve_polyline` — polyline.rs:20
- `sample_composite_curve_edge` / `sample_polyline_edge` — edge_loop.rs:244 / :289
- `SurfaceOfLinearExtrusionProcessor::get_profile_curve_points` / `curve_points_inner` / `extract_composite_curve_points` — surface.rs:148 / :215 / :268

**Entity attribute access/decoding**
- `extract_loop_points` (dead) / `extract_loop_points_fast` — faceted.rs:37 / :81
- `extract_vertex_coords` — advanced_face/curves.rs:16
- `parse_curve_knots` — curves.rs:34
- `read_trim_parameter` — curves.rs:58
- `parse_rational_weights` — bspline_parse.rs:14
- `control_point_grid_dims` — bspline_parse.rs:38
- `parse_control_points` — bspline_parse.rs:47
- `expand_knots` — bspline_parse.rs:101
- `parse_knot_vectors` — bspline_parse.rs:118
- `sample_edge_curve_points` — edge_loop.rs:21
- `extract_edge_loop_points` — edge_loop.rs:70
- `extract_edge_loop_points_for_bounds` — edge_loop.rs:343
- `apply_same_sense` — advanced_face/mod.rs:38
- `process_advanced_face` — advanced_face/mod.rs:66
- `resolve_edge_points` / `resolve_vertex_point` — structural_edge.rs:73 / :270
- `boolean_operator` — boolean/operand.rs:93
- `process_operand_checked` — operand.rs:134
- `parse_polygonal_boundary_2d` — polygonal_prism.rs:14
- `collect_polygonal_chain` — boolean/mod.rs:229
- `mesh_face_collections` / `mesh_surface_model` — brep/surface_model.rs:41 / :184

**Colour/style**
- None in this sub-area.

**Error types / diagnostics**
- All errors are `crate::Error::geometry(String)`; samplers return `Option` or an empty `Vec` instead.
- `BoolFailure` log: `record_failure` / `take_failures` / `absorb_failures` / `failure_mark` / `rewind_to` / `defer_after` / `record_empty_operand` — boolean/failures.rs:58 / :54 / :67 / :72 / :93 / :100 / :110
- `SingleCutterSubtract` — single_cutter_gate.rs:17
- `note_curve_capped` / `take_curve_capped` (thread-local) — bspline_budget.rs:105 / :112
- `trace_capped_face` — surface_model.rs:19
- `trace_capped_advanced_brep_face` — advanced.rs:28