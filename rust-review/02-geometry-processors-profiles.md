# Geometry processors / profiles / extrusion / rect_fast / profile_extractor / alignment / void & material-layer indexes review

Scope: `rust/geometry/src/processors/**`, `rust/geometry/src/profiles/**`, and the top-level files `extrusion.rs`, `rect_fast.rs` (+`rect_fast/`), `profile_extractor.rs`, `material_layer_index.rs`, `alignment*.rs` and `void_index.rs`, with their tests. Prefix `PROC`. Paths are relative to `rust/geometry/src/` unless they start with `rust/`.

The area was split three ways:
- **This file.** My own findings in full (PROC-1..28), covering profiles/, the extrusion processors, swept/, tessellated/, csg_primitive/sphere, helpers.rs, processors/mod.rs, extrusion.rs, rect_fast and profile_extractor.
- **`02a-proc-boolean-brep-surface.md`** (PROC-S1..32). Covers boolean/, advanced_face/, advanced.rs, brep/, surface.rs and structural_*.
- **`02b-proc-alignment-sectioned-voids.md`** (PROC-AL-1..30). Covers alignment*, sectioned*, curve_walk, texture/, void_index and material_layer_index.

The helper findings are indexed below. All three sets were verified against the code.

## Summary
- **Placement, point and direction decoding is written about 14 times, and the copies disagree (PROC-1).** This review counts 14+ sites. Two helper findings report the same problem for their own files: PROC-S7 (4 forks) and PROC-AL-10.
  - The copies disagree on what a null `Location` means: origin in some, an error in others.
  - They disagree on the default for a missing 3rd ratio: 0 or 1.
  - They also differ on type checks, on whether errors are swallowed, and on orthonormalisation.
  - `transform.rs:75` claims that every parser shares `build_axis2_matrix`. That is false.
  - Result: 3D conic frames can be NaN or skewed, and a full circle and a trimmed circle on the same placement sample different circles (PROC-13).
- **There are three or four independent IFC curve samplers, and they have drifted.**
  - The samplers are `ProfileProcessor`; advanced_face polyline/edge_loop; surface.rs; and the PBHS boundary parser (PROC-11, PROC-S1).
  - Inside `ProfileProcessor` alone there are four composite-curve walkers with four junction rules (PROC-5) and four trimmed-curve interpreters (PROC-6).
  - Circle/arc sampling loops appear about 15 times (PROC-7), and the indexed polycurve has 2D/3D twins (PROC-8).
  - There are three clothoid integrators (PROC-AL-3), and vertical arcs are modelled two ways (PROC-AL-4).
  - Visible consequences:
    - a B-spline curve gets an extra point at the world origin (PROC-S2);
    - parameter-trimmed arcs render as full circles (PROC-S1);
    - IFC4x3 composite profiles come out empty (PROC-5);
    - trims on polyline bases are ignored (PROC-6).
- **Valid IFC silently produces wrong solids:**
  - `IfcTriangulatedFaceSet` ignores `PnIndex`, which the polygonal sibling honours (PROC-3).
  - Revolved solids drop profile holes (PROC-4), and so do sectioned solids (PROC-AL-5).
  - `IfcCompositeProfileDef` turns its disjoint sub-profiles into holes (PROC-15).
  - Faceted breps fill authored holes when triangulation fails (PROC-S5).
  - B-spline faces ignore their bounds (PROC-S20).
  - `IfcFacetedBrepWithVoids` and `IfcSurfaceOfLinearExtrusion` are not routed at all (PROC-S6).
- **`profile_extractor.rs` is a hand-copied second pipeline (PROC-2).** It already misplaces 2D profiles of linear- and grid-placed elements, applies different ExtrudedAreaSolid defaults, and under-reports skipped profiles.
- **Fast paths have drifted from the general paths.**
  - The CoordIndex raw-byte fast path accepts `-`, flattens faces, and maps `0` or negative indices to valid vertices; the slow path drops them (PROC-14).
  - Faceted and polygonal quad fans bypass the ear-clip path and get concave quads wrong (PROC-18, PROC-S4, PROC-S10).
  - rect_fast's work is bounded by opening count rather than cell count, so a single element can cost about 10^10 operations (PROC-16). Its parametric path also loses defer telemetry (PROC-21).
- **The same per-IFC-type scaffolding is copy-pasted across processors:**
  - optional `Position`, ExtrudedDirection and extrusion shear (PROC-10);
  - ring stitching for sweep/tube/revolve/loft that does not use the canonical `outward_is_right_hand` (PROC-9);
  - flat shading and shell orientation (PROC-17, PROC-S12);
  - `Mesh {..}` struct literals (PROC-24, PROC-S12);
  - `.T.`/`.F.` parsing at about 20 sites (PROC-12, PROC-S11, PROC-AL-9);
  - work budgets (PROC-AL-7, PROC-S15);
  - relationship folds duplicated against `processing/prepass.rs`, with the #2019 ordering fix on one side only (PROC-AL-1).
- **Tolerances and test helpers have no shared home** (PROC-27, PROC-S32, PROC-AL-20; PROC-20, PROC-S31, PROC-AL-28).
  - "Same point" means 1e-6, 1e-9, 1e-10 or exact equality depending on the file, always in file units. Several comments assume metres.
  - `mesh_volume` and `open_edges` are redefined in dozens of test files.

## Findings (own: PROC-1..28)

### PROC-1: `IfcAxis2Placement3D` / `IfcCartesianPoint` / `IfcDirection` decoding is implemented ~14 times and the copies have drifted
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - `processors/helpers.rs:31` `parse_axis2_placement_3d`, `:83` `parse_cartesian_point`, `:121` `parse_direction`, `:172` `get_axis2_placement_transform_by_id`, `:213` `get_direction_by_id`
  - `transform.rs:26` `parse_axis2_placement_3d`, `:134` `parse_cartesian_point`, `:157` `parse_decoded_cartesian_point`, `:186` `parse_cartesian_point_from_id` (re-inlines the coordinate read a 3rd time inside the same file), `:225` `parse_direction_from_id`, `:233` `parse_axis2_placement_3d_from_id`, `:286` `parse_direction`
  - `router/transforms/parsers.rs:16/61/100` (`GeometryRouter::parse_axis2_placement_3d/parse_cartesian_point/parse_direction` — methods that never use `self`; jscpd 34+23-line clones of helpers.rs)
  - `router/transforms/operator.rs:234` `parse_direction_ratios` ("Mirrors `GeometryRouter::parse_direction`, minus the router")
  - `profile_extractor.rs:603` `parse_axis2_placement_3d`, `:647` `parse_cartesian_point`, `:677` `parse_direction_entity`, `:691` `parse_extrusion_direction` (banner at :568 literally says "Duplicated from processors/helpers.rs")
  - `profiles/curves_3d.rs:64` `read_conic_placement_3d` (both 3D and 2D branches hand-rolled)
  - `profiles/placement.rs:13` `apply_profile_position` (hand-rolled Axis2Placement2D), `:214` `get_placement_2d` (2D branch hand-rolled; 3D branch delegates to `transform`)
  - `profiles/mod.rs:782` `axis2_placement_location_and_x_axis_3d`
  - `processors/advanced_face/conics.rs:13` `read_axis2_placement_3d`
  - `curve_segment.rs:101` `read_placement`
  - `curve_source.rs:188` `circle_basis` (2D branch), `transform/placement_2d.rs:14` `parse_axis2_placement_2d`
  - inline IfcDirection reads: `processors/extrusion.rs:142-185`, `processors/extrusion_tapered.rs:63-100`, `processors/swept/revolved.rs:89-132` (IfcAxis1Placement), `profiles/curves_2d.rs:43-50` (trim point)
- What: the same three IFC leaf entities are decoded by hand everywhere, each with its own defaults, type checks and error policy. Observed drift:
  - Null/absent `Location`: `helpers.rs:37-45` → origin; `transform.rs:31` and `router/transforms/parsers.rs:21` → `Err("Failed to resolve cartesian point")`; `profile_extractor.rs:607` → origin via `unwrap_or`; `profiles/mod.rs:791` → `None` (segment skipped).
  - Missing 3rd direction ratio: `0.0` in `transform.rs`/`helpers.rs`/router/`operator.rs`, but `1.0` in `profile_extractor.rs:686`, `profiles/curves_3d.rs:104` (Axis), and the ExtrudedDirection reads `processors/extrusion.rs:178`, `extrusion_tapered.rs:94`, `profile_extractor.rs:705`; `revolved.rs:118` defaults the **Y** ratio to `1.0`; `profiles/placement.rs:48` and `curves_3d.rs:128/180` default the **X** ratio to `1.0`. A 2-ratio `IfcDirection((1.,0.))` therefore becomes `(1,0,0)` in one path and `(1,0,1)` in another.
  - `IfcType` check: `helpers::parse_direction`, `transform::parse_direction`, router, `operator.rs` reject non-`IfcDirection`; `helpers::get_direction_by_id:213`, `profile_extractor::parse_direction_entity`, `conics.rs:30`, `curves_3d.rs:95-144` read attribute 0 of anything.
  - Error policy: `helpers::get_axis2_placement_transform_by_id:172` silently defaults every unreadable sub-entity (`.unwrap_or`), while its twin `transform::parse_axis2_placement_3d_from_id:233` propagates errors; `get_direction_by_id` additionally requires the first ratio to exist (`ratios.first()?`) where every other copy defaults it to 0.
  - Orthonormalisation: everything that routes through `transform::build_axis2_matrix` is canonical; `curves_3d.rs:106/132/147` uses bare `.normalize()` and never orthogonalises X against Z (see PROC-13), `conics.rs:47-60` invents its own RefDirection default (`|z.x|<0.9` threshold instead of the IFC `FirstProjAxis` rule `build_axis2_matrix` implements), `profiles/mod.rs:812` returns the raw RefDirection without projecting out Axis.
- Why it matters: every placement-related fix (#1985, #2873, the zero-direction NaN fixes noted in `transform.rs:85` and `profile_extractor.rs:676`) has had to be re-applied fork-by-fork and several forks still miss them. The doc comment at `transform.rs:75` claims "Every IfcAxis2Placement3D parser in the crate ... shares only this orthonormalization", which is false for `curves_3d.rs`, `conics.rs` and `profiles/mod.rs`.
- Fix: one router-free module (`transform/` already exists) exposing `read_point3(attr|id)`, `read_direction(attr|id) -> Result<Vector3>` (raw ratios, z=0 default, type-checked), `axis2_placement_3d(entity) -> Frame`, `axis2_placement_2d`, `axis1_placement`, plus a `Frame { origin, x, y, z }` that converts to `Matrix4`. Delete `processors/helpers.rs` placement functions, the `GeometryRouter::parse_*` methods, `operator::parse_direction_ratios`, the `profile_extractor` copies and the conic/curve-segment readers; callers that want "lenient" behaviour wrap the `Result` themselves. Decide the null-Location policy once (schema says mandatory; origin fallback is the friendlier choice) and pin it with one test.
- Effort: M

### PROC-2: `profile_extractor.rs` is a parallel element→placement→mapped-item→extrusion pipeline that has already drifted from the mesh path (misplaces linear/grid-placed elements)
- Category: Bug
- Severity: High
- Confidence: CONFIRMED
- Where: `profile_extractor.rs:510-566` (`get_placement_transform`/`get_placement_recursive`, banner "Duplicated from router/transforms.rs ... to avoid coupling"), `:387-500` (`extract_extruded_solid`), `:234-367` (mapped items), `:747` (`detect_unit_scale`) vs `router/transforms/walk.rs:47-140`, `processors/extrusion.rs:110-223`, `router/mapped_item.rs`, `router/mod.rs:285` (`with_units`)
- What:
  - `get_placement_recursive:530` returns identity for anything that is not `IfcLocalPlacement`, and `:556` for a `RelativePlacement` that is not `IfcAxis2Placement3D`. The mesh path (`router/transforms/walk.rs:116,130`) resolves `IfcLinearPlacement` (IFC4x3 infrastructure) and `IfcGridPlacement`. Every 2D drawing profile of a linear- or grid-placed element is therefore emitted at the parent frame/origin while the 3D mesh is in the right place. `router/transforms/placement_depth_tests.rs:65` exists precisely because this walk diverged before (#2873).
  - ExtrudedAreaSolid attribute policy diverges from `ExtrudedAreaSolidProcessor`: missing `Depth` → `1.0` (`:456`) vs `Err` (`processors/extrusion.rs:188`); zero-length `ExtrudedDirection` → `+Z` (`:713`) vs `Err` (`processors/extrusion.rs:181`); non-`IfcDirection` accepted vs rejected.
  - "Silent" drops in the `_with_diagnostics` variant: `extract_mapped_item_profiles` returns without a `SkippedProfile` on an unresolvable `MappingSource` (`:266`), unparseable `MappingTarget` (`:275/279`), `MappingOrigin` (`:293/300`), `MappedRepresentation`/items (`:317/325`) — only the depth-exceeded and solid errors are recorded, so the diagnostics API under-reports.
  - Unit detection (`:747`) re-implements `GeometryRouter::with_units`.
- Why it matters: 2D drawings and 3D model disagree for IFC4x3 infrastructure and grid-placed columns; every future placement feature has to be implemented twice.
- Fix: make the extractor reuse the router's placement resolver (`GeometryRouter::get_placement_transform_from_element`) and `with_units`; extract an `ExtrudedAreaSolidParams::decode(entity, decoder) -> Result<{profile, position, direction, depth}>` used by both `ExtrudedAreaSolidProcessor`, `ExtrudedAreaSolidTaperedProcessor` and the extractor; push a `SkippedProfile` on every early return.
- Effort: M

### PROC-3: `IfcTriangulatedFaceSet` ignores `PnIndex` while `IfcPolygonalFaceSet` honours it
- Category: Bug
- Severity: High
- Confidence: CONFIRMED
- Where: `processors/tessellated/triangulated.rs:33-95` (reads attrs 0,2,3 only) vs `processors/tessellated/polygonal.rs:104-110,20-37` (reads `PnIndex` attr 3 and remaps); `processors/mod.rs:76` fast path; schema `rust/core/src/generated/ifc4/schema.rs:7306` (`"Coordinates","Normals","Closed","CoordIndex","PnIndex"`)
- What: per IFC4 `IfcTriangulatedFaceSet.PnIndex`, when present, `CoordIndex` values index `PnIndex`, whose values index `Coordinates`. The triangulated processor uses `CoordIndex` directly against `Coordinates`; the polygonal sibling does the remap. Also the two processors disagree on orientation gating: triangulated orients unless `Closed = .F.` (`triangulated.rs:82-93`), polygonal only when `Closed = .T.` (`polygonal.rs:148-155`) — `$` is treated oppositely.
- Why it matters: any valid IFC4 file that uses `PnIndex` on a triangulated set (exporters that share one point list across several face sets) renders scrambled triangles or has them dropped by `validate_indices` — silently.
- Fix: share one `read_index_remap(entity, attr_idx) -> Option<Vec<u32>>` and apply it in both processors (and in the texture path); pick one `Closed`-gating policy and document it once in `tessellated/mod.rs`. Note `polygonal.rs:107` filters non-positive entries out of `PnIndex` *before* indexing, which shifts every subsequent remap position — map them to a sentinel instead.
- Effort: S

### PROC-4: `RevolvedAreaSolidProcessor` revolves only `profile.outer`; holes are dropped and winding ignores profile orientation
- Category: Bug
- Severity: High
- Confidence: CONFIRMED (holes) / LIKELY (winding)
- Where: `processors/swept/revolved.rs:145-249`
- What: `let profile_points = &profile_2d.outer;` — `profile_2d.holes` is never read. A revolved `IfcCircleHollowProfileDef`/`IfcRectangleHollowProfileDef`/`IfcArbitraryProfileDefWithVoids` (pipe bends, tori, turned parts) becomes a solid body. The end caps are `safe_earcut` of the outer ring only (`:227`). Side-quad winding (`:192-201`) is fixed regardless of the profile's winding (arbitrary profiles are not normalised to CCW — `profiles/mod.rs:285` never calls `make_outer_ccw`) and of the sign of `Angle`, while the cap winding is fixed by index; a CW profile yields a mesh whose walls and caps disagree. Unlike `extrude_rings_into`, which keys walls off the shared `extrusion_generic::outward_is_right_hand` rule. Mitigated in the main pipeline by `processing/src/element.rs:467` `orient_mesh_outward_verdict`, but not for CSG operands (a revolved solid inside an `IfcBooleanResult`) or direct router users.
- Why it matters: visibly wrong solids (hollow parts rendered solid; wrong volume/quantities).
- Fix: build rings for outer and every hole, wind each via `outward_is_right_hand(ring, Ring::Outer|Hole)` and the sign of the angle, and triangulate caps with `triangulate_rings(outer, holes)`; consider routing through a shared "sweep rings along frames" helper also used by `swept/surface_curve.rs:168` (see PROC-9).
- Effort: M

### PROC-5: Composite-curve traversal exists 4× with 4 different junction-dedup rules and different segment-type coverage
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: 2D `profiles/mod.rs:674-731` (`process_composite_curve_with_depth`); 3D `profiles/mod.rs:481-601` (`process_composite_curve_3d_with_depth`); trimmed directrix `profiles/directrix.rs:123-248` (`get_composite_curve_points_trimmed`); advanced-face sampler `processors/advanced_face/polyline.rs` / `edge_loop.rs` (separate curve walker, see PROC-11)
- What:
  - Junction handling: 2D uses exact `!=` (`:722`); 3D `IfcCompositeCurveSegment` branch unconditionally drops the first point of every following segment (`:584-588` `skip(1)`); 3D `IfcCurveSegment` branch dedups at `1e-9` (`:505,525`); directrix dedups at `JUNCTION_EPS = 1e-6` (`directrix.rs:232`) with a comment explaining that unconditional dropping "distorts the directrix" — i.e. the untrimmed 3D path still has the bug the trimmed path fixed.
  - Segment types: 2D `continue`s on anything that is not exactly `IfcCompositeCurveSegment` (`:691`), silently dropping IFC4 `IfcReparametrisedCompositeCurveSegment` (a subtype) and IFC4x3 `IfcCurveSegment` — an IFC4x3 `IfcArbitraryClosedProfileDef` over an `IfcCompositeCurve` of `IfcCurveSegment`s yields an empty outline, and `ExtrudedAreaSolidProcessor` (`processors/extrusion.rs:137`) then returns an empty mesh with no error. 3D handles `IfcCurveSegment` (`:500`) but the trimmed directrix (`directrix.rs:141-146`) reads attr 2 of an `IfcCurveSegment` (its `SegmentStart`) as `ParentCurve` and fails the whole solid with "Failed to resolve ParentCurve" — so an `IfcSweptDiskSolid` with `StartParam/EndParam` along an IFC4x3 composite/gradient curve errors while the same solid without params renders.
  - SameSense parse differs (`"T"||"TRUE"` in all three, but see PROC-12).
- Why it matters: shape-changing behaviour depends on which entry point reached the curve; silent empty profiles.
- Fix: one `CompositeCurveWalker` yielding `(parent_curve, same_sense, span)` that understands both segment flavours, plus one `append_polyline_dedup(out, pts, eps)` helper with a single named `CURVE_JUNCTION_EPS`; 2D = 3D walker projected to XY.
- Effort: M

### PROC-6: `IfcTrimmedCurve` interpretation (trim selects, sense, seam wrap) is implemented in four places; non-conic/non-line trims are silently ignored
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `trimmed_curve.rs:41` (`decode_trimmed_primitive`, lines+circles, "shared by analytic and mesh"), `curve_source.rs:156` `trim_point`, `:227` `trim_angle`; `profiles/curves_2d.rs:21` `extract_trim_select` + `:70` `process_trimmed_conic` (2D circles **and ellipses**); `profiles/curves_3d.rs:260` `process_trimmed_ellipse_3d` + `:343` `trim_to_angle_3d` (3D ellipses and malformed circles); also `rust/processing/src/symbolic/trimmed_curve.rs:77` (cross-crate)
- What: trim-select parsing (IFCPARAMETERVALUE wrapper vs bare number vs IfcCartesianPoint, MasterRepresentation preference) is copy-pasted (`curves_2d.rs:29-64` ≈ `curves_3d.rs:355-399`, jscpd 13 lines) and re-implemented in `curve_source::trim_angle`. The sense seam-wrap (`if sense && end < start { end += 2π } ...`) is duplicated at `curves_2d.rs:117-121`, `curves_3d.rs:321-325`, `trimmed_curve.rs:136-141`. SenseAgreement is parsed as `s == "T"` in `profiles/mod.rs:645`, `curves_3d.rs:286`, `trimmed_curve.rs:52`. In `profiles/mod.rs:665-669` any basis other than circle/ellipse/line (IfcPolyline, B-spline, nested trimmed) falls through to `process_curve_with_depth(&basis_curve)` and **Trim1/Trim2 are discarded**, even though `curves_3d.rs:442` `get_polyline_points_trimmed` already implements parameter trimming of polylines. Missing radius: `curves_2d.rs:79,201,226` and `curves_3d.rs:266` default to `1.0` (one file unit — 1 mm in mm files), `curves_3d.rs:200`/`directrix.rs:96-98`/`curve_source.rs:198` error.
- Why it matters: a trimmed polyline profile outline (legal and emitted by some tools) renders the whole basis polyline; three seam-wrap copies already differ from the analytic `RequireBoth` rule.
- Fix: extend `trimmed_curve::decode_trimmed_primitive` to `Ellipse` and `Polyline` bases (or a generic "parameter window" result) and make every sampler consume it; delete `extract_trim_select`/`trim_to_angle_3d`.
- Effort: M

### PROC-7: Circle/ellipse/arc point generation is written ~15 times; segment-count policies and handedness differ
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - chord-adaptive segment count copied verbatim: `profiles/curves_2d.rs:140-163` and `profiles/directrix.rs:262-283` (jscpd 18 lines; `CHORD_TOL_M = 5e-4` defined twice)
  - full-circle/ellipse loops: `profiles/shapes.rs:83-88` (circle), `:265-279` (hollow circle, outer+inner), `profiles/curves_2d.rs:194-217` (IfcCircle), `:220-246` (IfcEllipse — identical body with two radii), `profile.rs:261-290` (`create_circle`, outer+hole), `profiles/curves_3d.rs:207-214` (`process_circle_3d`), `processors/swept/disk.rs:167-172` (`unit_circle`), `processors/sphere.rs:90-106`
  - arc loops: `profiles/curves_2d.rs:165-189` (trimmed conic), `profiles/directrix.rs:285-293` (`sample_conic_arc_3d`), `profiles/outline.rs:206-218` (rounded-rect corners), `:254-269` (`push_arc`), `:283-318` (`round_corner`), `profiles/curves_2d.rs:436-524` (`approximate_arc_3pt`), `profiles/outline.rs:56-137` (`approximate_arc_3pt_3d`)
- What: drift between copies — `ProfileProcessor::process_circle` uses a fixed `circle_profile_segments(36)` while `profile::create_circle` uses radius-adaptive `calculate_circle_segments` (8..32) for the same IFC concept; `process_circle_curve`/`process_ellipse_curve` ignore the `y_sign` handedness returned by `get_placement_2d` (#6597) that `process_trimmed_conic` honours (a full conic on a `-Z` placement is traversed CW); `process_circle_3d` emits a closing duplicate (`0..=segments`) while the 2D samplers do not; 2D 3-point arcs cap at `profile_arc_segments(..).min(16)` while 3D uses `scale_segments(..,4,16,q)`.
- Why it matters: every density/handedness fix must be made N times; tessellation differs between the profile cap and the swept body of the same circle.
- Fix: `tessellation.rs` (or a new `arc.rs`) with `conic_arc_segments(arc_angle, r_max, unit_scale, quality) -> usize`, `sample_ellipse_arc(frame, (rx, ry), a0, a1, n, closed: bool)` generic over 2D/3D frame, and `fit_arc_3pt(p1,p2,p3) -> Option<Arc>`; shapes/curves/outline/directrix/disk call those.
- Effort: M

### PROC-8: `IfcIndexedPolyCurve` is parsed twice (2D and 3D) and the copies disagree on malformed input
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `profiles/curves_2d.rs:287-433` vs `profiles/curves_3d.rs:473-597` (segment-typing, index validation, arc estimate copied nearly verbatim); `approximate_arc_3pt` `curves_2d.rs:436` vs `approximate_arc_3pt_3d` `outline.rs:56`; `process_polyline` `curves_2d.rs:249` vs `process_polyline_3d` `curves_3d.rs:403`
- What: 2D `filter_map`s coordinates with `?` (`curves_2d.rs:315-324`) — a malformed coordinate tuple is *removed*, shifting every later 1-based index onto the wrong vertex; 3D keeps it with 0 defaults. Dedup: exact `!=` (2D) vs `same_point_3d` 1e-9 (3D). Collinearity: `1e-6 * span²` (2D, on the determinant) vs `1e-12 * span⁴` (3D, on |a×b|²). `process_polyline` skips non-`IfcCartesianPoint` items, `process_polyline_3d` does not check type. `type_name.to_uppercase().contains("ARC")` allocates per segment in both.
- Why it matters: profile outline and directrix of the same curve differ on bad input; maintenance doubled.
- Fix: one generic sampler producing `Vec<Point3>`; 2D callers project (`z` ignored). Keep tuple positions stable (push a sentinel/NaN-free default and drop the *segment* that references it).
- Effort: S

### PROC-9: Sweep-along-frames / tube / revolve mesh assembly duplicated without the shared outward-winding rule
- Category: DRY
- Severity: Medium
- Confidence: LIKELY
- Where: `processors/swept/surface_curve.rs:168-243` (`sweep_profile_along_frames`), `processors/swept/disk.rs:152-235` (`build_tube`), `processors/swept/revolved.rs:145-249`, `extrusion.rs:373-418` (`create_lofted_side_walls`) vs the canonical `extrusion_generic.rs:194` (`outward_is_right_hand`) / `:208` (`create_side_walls`)
- What: each sweep builds ring vertices, connects ring i→i+1 per loop, and emits caps, with hand-chosen index orders. `sweep_profile_along_frames:204-207` documents "with a CCW outer loop ... A CW hole loop flips the sign" — but arbitrary profiles are not normalised (`profiles/mod.rs:285-320` never calls `make_outer_ccw`; holes are never forced CW), so a CW-authored outer produces inward walls against `earcut` caps (whose triangle orientation is input-independent) → inconsistent winding before `calculate_normals:241` bakes smooth normals. `extrusion_generic.rs:190-203` exists precisely to stop this class of bug ("Holes keyed off winding alone faced into the solid ... (#5410)"). `surface_curve.rs:110-118` also re-dedups points that `build_tube_rmf` already dedups (`disk.rs:59-70`) with a stale "zero-length step yields a NaN tangent" comment, and calls `set_tessellation_quality` right before `process` which sets it again (`:74-77`).
- Why it matters: four mesh assemblers, one of which has the canonical fix; post-hoc `orient_mesh_outward_verdict` in `processing` masks it only in the main pipeline (and normals are only recomputed when it flips).
- Fix: `extrusion_generic` grows `sweep_rings(rings_per_station, ring_kinds, caps)`; lofted, surface-curve, revolve and tube all call it and use `outward_is_right_hand`.
- Effort: M

### PROC-10: "optional `Position` → matrix", ExtrudedDirection parsing and the extrusion shear are copy-pasted across solid processors
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: optional Position: `processors/extrusion.rs:194-210`, `extrusion_tapered.rs:107-123`, `csg_primitive.rs:75-92`, `sphere.rs:61-70`, `swept/revolved.rs:57-69`, `swept/surface_curve.rs:124-130`, `profile_extractor.rs:410-430`, `profiles/mod.rs:217-226` (2D); ExtrudedDirection: `processors/extrusion.rs:142-185`, `extrusion_tapered.rs:63-100`, `profile_extractor.rs:691-716`; extrusion shear/flip: `processors/extrusion.rs:35-93` (`extrusion_local_transform`, `pub(crate)`) vs `extrusion_tapered.rs:125-141` ("Same Z-aligned vs shear branch as ExtrudedAreaSolidProcessor") — jscpd 17-line clones at `extrusion.rs:166-182/194-210` ↔ `extrusion_tapered.rs:82-97/107-123`
- What: drift — extrusion/tapered/csg/sphere silently ignore a non-`IfcAxis2Placement3D` Position, revolved/surface-curve feed anything to `helpers::parse_axis2_placement_3d` (which does not type-check, so an `IfcAxis2Placement2D` would have its RefDirection read as the Axis); profile_extractor scales translation inline. Tapered keeps the pre-generic shear copy that `extrusion_byte_identity_tests.rs:330-351` preserves as the *test reference*, so production has two implementations of the same transform. Validation differs: Block/Sphere check `is_finite() && > 0` (`csg_primitive.rs:68`, `sphere.rs:50`); ExtrudedAreaSolid relies on `depth.value() <= 0.0` (`extrusion_generic.rs:35`), which lets `NaN` through and accepts `inf`.
- Why it matters: copy drift in the most-used processor (extrusions are the bulk of BIM geometry).
- Fix: `fn read_optional_position(entity, idx, decoder) -> Result<Option<Matrix4>>` (type-checked, one policy) and `fn read_extrusion(entity) -> ExtrusionParams`; tapered calls `extrusion_local_transform`; a shared `require_positive_length` (already exists as `profiles/steel_shapes.rs:20`) for every `IfcPositiveLengthMeasure`.
- Effort: S

### PROC-11: Two independent IFC curve → polyline samplers (profiles vs advanced faces) with different guards and coverage
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `profiles/mod.rs:330-477` (`ProfileProcessor::get_curve_points`, guards `MAX_CURVE_DEPTH = 50` + `MAX_CURVE_NODES = 100_000`), `profiles/curves_3d.rs`, `profiles/directrix.rs` vs `processors/advanced_face/polyline.rs:20-60` (`sample_curve_polyline`, guards visited-set + `MAX_BASIS_CURVE_DEPTH = 32`), `advanced_face/edge_loop.rs`, `advanced_face/conics.rs`, `advanced_face/curves.rs` (B-spline); plus `curve_segment.rs:121` (IFC4x3 segments) and `alignment*`
- What: both walk `IfcLine/IfcCircle/IfcEllipse/IfcTrimmedCurve/IfcCompositeCurve` and sample them; only the advanced-face one samples `IfcBSplineCurveWithKnots` (profiles error "Unsupported curve type" for a B-spline outer curve or directrix), only the profile one handles `IfcIndexedPolyCurve`/`IfcPolyline`/IFC4x3 segments. They use different placement readers (`conics.rs:13` vs `curves_3d.rs:64`), different density rules, and different DoS guards.
- Why it matters: every curve type has to be added (and secured) twice; behaviour of the same curve differs between a swept solid and an advanced brep edge.
- Fix: one `curve_sampler` module (`fn sample_curve(entity, decoder, ctx) -> Result<Vec<Point3>>` with one budget/guard object) used by profiles, directrices, advanced-face edges and surface-of-revolution generators.
- Effort: L

### PROC-12: STEP BOOLEAN/LOGICAL enum decoding hand-rolled at ~20 sites with drifting spellings and defaults
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `profiles/mod.rs:573` (`"T"||"TRUE"`), `:645` (`"T"`), `:709` (`"T"||"TRUE"`), `profiles/curves_3d.rs:286` (`"T"`), `profiles/directrix.rs:153`, `trimmed_curve.rs:52`, `alignment.rs:126`, `processors/tessellated/triangulated.rs:85` (`== "F"`), `processors/tessellated/polygonal.rs:151`, `processors/sectioned.rs:149`, `processors/sectioned_positions.rs:133`, `processors/texture/mod.rs:190`, `processors/structural_edge.rs:117`, `processors/advanced_face/mod.rs:45`, `polyline.rs:238`, `bounds.rs:57`, `edge_loop.rs:47,96,194,262`, `processors/boolean/mod.rs:125`, `analytic/curve.rs:220,277`; cross-crate `rust/processing/src/symbolic/trimmed_curve.rs:77` (`"T"||"TRUE"||".T."`)
- What: `.T.`/`.F.`/`.U.` reading is open-coded each time; some sites accept `"TRUE"`, one accepts `".T."`, most only `"T"`; defaults for `$`/`.U.` vary (true, false, "unknown means closed"). Some match `AttributeValue::Enum(s)` directly, others `as_enum()`.
- Why it matters: easy to get the `$`/`.U.` default wrong; no single place to fix if the lexer ever changes how logicals are represented.
- Fix: `ifc_lite_core::AttributeValue::as_logical() -> Option<Logical { True, False, Unknown }>` and `DecodedEntity::get_bool(idx, default)`; replace all sites.
- Effort: S

### PROC-13: 3D conic placement reader produces NaN or skewed frames; full circles and trimmed circles use different frames
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: `profiles/curves_3d.rs:76-149` (`read_conic_placement_3d`), used by `process_circle_3d:204`, `process_trimmed_ellipse_3d:273`, `directrix.rs:104` (conic directrix); compare `curve_source.rs:203-209` (`circle_basis` → canonical `transform::parse_axis2_placement_3d`) used for trimmed circles via `curves_3d.rs:238`
- What: Axis and RefDirection are `.normalize()`d bare (`:106`, `:132`) — `IfcDirection((0.,0.,0.))` gives NaN points that flow into `build_tube_rmf`; `directrix_is_sweepable` then rejects the whole solid as a load error. RefDirection is never projected onto the plane ⟂ Axis, so `y = z × x` normalised is not perpendicular to `x` when the file's directions are slightly non-orthogonal (common after round-tripping) — the "circle" becomes an ellipse sheared in its own plane. Missing Axis z defaults to `1.0`. Meanwhile a *trimmed* circle on the same placement goes through `circle_basis` → `build_axis2_matrix` (orthonormal, NaN-guarded), so a full `IfcCircle` directrix and a `IfcTrimmedCurve(IfcCircle)` directrix on the same placement sample different circles.
- Why it matters: rebar/duct sweeps (`IfcSweptDiskSolid` over `IfcCircle`/`IfcEllipse`) get skewed or dropped.
- Fix: replace the 3D branch with `transform::parse_axis2_placement_3d` (as `get_placement_2d` and `circle_basis` already do) and the 2D branch with `transform::parse_axis2_placement_2d`.
- Effort: S

### PROC-14: CoordIndex fast path and slow path disagree on malformed input; validator explicitly allows `-`
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: `processors/mod.rs:76-193` (`extract_coord_index_bytes`, `validate_coord_index_structure` — `:177` accepts `b'-'`), `rust/core/src/fast_parse.rs:48-90` (`parse_indices_direct`), vs `rust/core/src/schema_gen.rs:239-269` (`parse_index_list`), called from `processors/tessellated/triangulated.rs:54-73`
- What: the fast path flattens every digit run regardless of face structure and ignores the sign: `-3` → index 2 (a valid vertex), `0` → `0.saturating_sub(1)` = 0 (vertex 1), a face with 2 or 4 entries shifts every following triangle. The slow path maps non-positive to the `u32::MAX` sentinel and reads exactly 3 per face. Which path runs depends only on whether `get_raw_bytes` succeeds, so the same file meshes differently in the fast/slow decoder configurations. The validator was clearly meant to reject such input but admits `-`.
- Why it matters: silently wrong triangles instead of dropped ones on malformed/hostile files; parser-path dependent output (determinism across native/wasm configs).
- Fix: reject `-` in the validator and verify each inner list has exactly 3 integers (or fall back to the slow path); move `extract_coord_index_bytes` next to `parse_indices_direct` in `ifc_lite_core::fast_parse` — it is a STEP-lexing concern, not a processor one.
- Effort: S

### PROC-15: `IfcCompositeProfileDef` turns every sub-profile after the first into a hole
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where: `profiles/mod.rs:735-764`
- What: "Add remaining profiles as holes (simplified - assumes they're holes)". `IfcCompositeProfileDef.Profiles` are *disjoint areas* (double angles, built-up/compound sections, twin-tube profiles), never holes of the first. A second profile outside the first becomes a "hole" outside the outer ring: earcut yields garbage caps, side walls of the "hole" face into nothing, and the CSG/void path sees a non-manifold solid.
- Why it matters: wrong geometry for a standard IFC profile type with no diagnostic.
- Fix: return `Vec<Profile2D>` (or let `Profile2D` carry multiple outers) and extrude each; until then, union the sub-profiles via `bool2d::union_contours_to_shapes` and error if the result is multiple shapes.
- Effort: M

### PROC-16: `rect_fast::build_cellular` work is bounded only by opening count (128), allowing ~10^10 operations
- Category: Perf
- Severity: Medium
- Confidence: LIKELY
- Where: `rect_fast.rs:233-237` (`MAX_FAST_OPENINGS = 128`), `:400-480` (`build_cellular`)
- What: each opening contributes up to 2 grid lines per axis → up to 258 lines/axis → 257³ ≈ 1.7·10⁷ cells. `solid()` is O(openings) and is evaluated for the cell plus up to 6 neighbours, i.e. ~1.7·10⁷ × 7 × 128 ≈ 1.5·10¹⁰ comparisons on a crafted (or merely staggered-depth) host, plus up to 1.7·10⁷ × 6 quads of output. The comment acknowledges "O(N^3) -> unbounded hang" but caps the wrong quantity.
- Why it matters: a single wall element can stall a worker for minutes under `panic=abort`-style budgets; the path is a pure optimisation and should defer instead.
- Fix: after `dedup_axis`, bail out (`stats.defer_too_many_openings`) when `(nx·ny·nz) > ~2^20`; precompute a `Vec<bool>` solid bitmap once (O(cells·openings)) and look neighbours up instead of re-evaluating.
- Effort: S

### PROC-17: Flat-shaded mesh builders, triangle-normal math and shell orientation duplicated in tessellated/
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `processors/tessellated/mesh_build.rs:157-221` (`build_flat_shaded_mesh`) vs `:231-312` (`_with_uvs`, comment "identical computation"; jscpd 28+13 lines); f32-triangle cross product repeated at `mesh_build.rs:113-135`, `:173-199`, `:254-267`, `tessellated/triangulate.rs:86-101`, `rect_fast.rs:159-171,350-358`; `orient_closed_shell_outward` (`mesh_build.rs:80-154`, a signed-volume test) vs `router/voids/geom.rs:331` `mesh_signed_volume`, `kernel/mesh_volume.rs:74`, `kernel/signed_volume.rs` `signed_volume6_of`, `mesh_orient.rs:158` `orient_mesh_outward`
- What: two copies of the flat-shade loop differing only in the UV push; at least five copies of "normal of triangle (i0,i1,i2) from f32 positions"; a third mesh-orientation implementation (whole-mesh flip by signed volume) next to `mesh_orient` (per-component) and the kernel's `orient_outward`.
- Fix: one `build_flat_shaded_mesh(positions, indices, uv: Option<(&[[f32;2]], &[[u32;3]])>)`; `Mesh::triangle_normal_f64(i)` helper; `orient_closed_shell_outward` → `kernel::signed_volume::signed_volume6_of` + swap.
- Effort: S

### PROC-18: `PolygonalFaceSet` polygon triangulation re-implements Newell + dominant-axis projection, and fans concave quads
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED (DRY) / LIKELY (concave quad)
- Where: `processors/tessellated/triangulate.rs:50-75` (Newell), `:153-171` and `:178-196` (identical projection block twice, jscpd 19 lines), `:123-127` (quad fan) vs `triangulation.rs:482` `calculate_polygon_normal`, `:416` `project_to_2d`
- What: the quad path fans `0-1-2, 0-2-3` without a convexity check; for a concave ("dart") quad whose reflex vertex is 0 or 2 the fan covers area outside the polygon, and `push_oriented_triangle` then flips the bad triangle to match, hiding it. The comment "For complex polygons (5+ vertices)" (`:45`) is stale (the ear-clip path handles 5+ *and* any face with holes).
- Fix: use `triangulation::calculate_polygon_normal` / a shared `dominant_axis_project` helper; only fan a quad when both diagonals are inside (or always earcut quads — they are cheap).
- Effort: S

### PROC-19: `simplify.rs` / `placement.rs` / `profile.rs` re-implement shared 2D polygon helpers
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: `profiles/simplify.rs:108` `perpendicular_distance` ≡ `geom2d.rs:72` `perp_distance`; signed area at `simplify.rs:257-262` and `:359-371` vs `bool2d.rs:201` `compute_signed_area`, `geom2d.rs:38` `polygon_area`, `extrusion_generic.rs:196-201`; `simplify.rs:197-208` `segments_properly_cross` (float orient) vs `geom2d.rs:105` `segments_intersect` (exact predicates); bbox loops `simplify.rs:326-343`, `profile.rs:46-59` (`center_on_bbox`), `extrusion_generic.rs:117-133`; outer+holes affine loops `profiles/placement.rs:82-98` and `:147-161`, `profile.rs:64-74`, `profiles/simplify.rs:93-104`
- What: small but numerous; the self-intersection backstop uses inexact orientation where the crate already ships exact Shewchuk predicates. `apply_profile_position` also defaults a missing RefDirection X ratio to 1.0 where `transform::parse_axis2_placement_2d` uses 0 and normalises in 2D vs 3D.
- Fix: `Profile2D::map_points(&mut self, f)`, `Profile2D::bbox()`, reuse `geom2d`/`bool2d` helpers; make `apply_profile_position` call `transform::parse_axis2_placement_2d` and apply the matrix.
- Effort: S

### PROC-20: Test helpers and decoding boilerplate copy-pasted across test files
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: mesh volume / signed volume: `processors/boolean/halfspace_cap_tests.rs:62`, `extrusion_watertight_tests.rs:128`, `processors/boolean/chain_cycle_tests.rs:330`, `world_frame_fixture.rs:125`, plus ~20 in `rust/geometry/tests/*.rs`; open edges: `rect_fast.rs:520`, `processors/boolean/halfspace_cap_tests.rs:33` vs `test_support.rs:20`; `processors/tests.rs:821` `mesh_surface_area`; `Rng` xorshift in `extrusion_byte_identity_tests.rs:355` and `scalar_adjoint_tests.rs:405`; "`EntityDecoder::new(content)` + `IfcSchema::new()` + `Processor::new()` + `decode_by_id(N)` + `process(..Medium)`" ×25 in `processors/tests.rs`, ×28 in `profiles/tests.rs` (jscpd: `processors/tests.rs:959-981 ↔ 1287-1309`, `1010-1032 ↔ 1119-1141`, `profiles/tests.rs:135-147 ↔ 154-166 ↔ 173-185`)
- Fix: put `mesh_volume`, `open_edges`, `surface_area`, `Rng`, and `fn mesh_of<P: GeometryProcessor>(step: &str, id: u32) -> Mesh` / `fn profile_of(step, id)` into `test_support.rs` (and a `tests/common` for integration tests).
- Effort: S

### PROC-21: rect_fast telemetry: parametric-path defers are never recorded; a dead counter; one counter still process-global
- Category: Bug
- Severity: Low
- Confidence: CONFIRMED
- Where: `router/voids/mod.rs:605-607` (`subtract_rect_openings(&host_f, &boxes, &mut stats)?;` then `self.record_rect_fast(&stats)`), `rect_fast.rs:49` (`defer_not_through` — never incremented anywhere), `rect_fast/param_stats.rs:5` (`PARAM_FIRES` static)
- What: the `?` returns before `record_rect_fast`, so every `defer_*` increment on the parametric path is lost (the legacy path at `router/voids/mod.rs:750-751` records unconditionally). `defer_not_through` is plumbed into the public `RectFastSummary` but is always 0. `PARAM_FIRES` is a process-global atomic while `rect_fast.rs:131-135` explains that the other counters were made request-local because globals "cross-contaminated concurrent loads"; tests (`tests/rect_param_gate.rs:305`) work around it with snapshot-and-diff.
- Fix: record before `?`; delete `defer_not_through` or wire it; move the param counter into `RectFastStats`.
- Effort: S

### PROC-22: Tapered loft resamples the coarser loop by arc length and cuts its corners; resampling is O(n·m)
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: `extrusion.rs:313-361` (`match_loop_lengths`, `resample_loop`)
- What: when `SweptArea` and `EndSweptArea` have different vertex counts (e.g. a 4-vertex rectangle tapering to a 36-vertex circle), the shorter loop is resampled at uniform arc-length steps starting at vertex 0; the original corners are only kept if they happen to land on a sample, so the start cap becomes a chamfered polygon smaller than the authored rectangle. `resample_loop:349-353` restarts the linear segment search from 0 for each output sample (O(n·target)).
- Fix: resample by inserting points on the shorter loop's edges while keeping its original vertices (distribute the extra count proportionally to edge length); walk `cum` monotonically.
- Effort: S

### PROC-23: Parametric profile builders validate and model attributes inconsistently; stale docs
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: `profiles/steel_shapes.rs:20` (`require_positive`, used by L/U/T/C/Z only) vs `profiles/shapes.rs` (rectangle, rounded rectangle, circle, hollow circle, rectangle hollow, I, asymmetric I — no positivity/finite checks); `shapes.rs:115-122` (I models FilletRadius) vs `:163-178` (asymmetric I ignores fillets with the stale claim "the existing symmetric `process_i_shape` ignores them too"); `steel_shapes.rs:220-262` (C ignores `InternalFilletRadius` attr 7 without saying so; no `girth <= half_depth` check → self-intersecting lips); `:266-304` (Z ignores FilletRadius/EdgeRadius); `shapes.rs:36` doc "Eight segments per quadrant" vs code 6 (`outline.rs:186`); `outline.rs:234` doc "within 1 µm" vs `1e-9` code (`:243`); missing profile types `IfcEllipseProfileDef`/`IfcTrapeziumProfileDef` error as unsupported, and supported types are registered twice (`rust/core/src/schema_gen.rs:390-426` HashMap + `profiles/mod.rs:194-207` match).
- Fix: run every `IfcPositiveLengthMeasure` through `require_positive`; fix docs; add Ellipse/Trapezium (trivial with the shared arc helper); derive the category from the match (or vice versa).
- Effort: S

### PROC-24: Full `Mesh { .. }` struct literals in processors
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `processors/swept/disk.rs:308-316`, `processors/swept/revolved.rs:251-258`, `processors/tessellated/mesh_build.rs:213-220`, `:302-309`, `processors/surface.rs:131`
- What: every field (`rtc_applied`, `origin`, `instance_meta`, `local_bounds`, `local_to_world`, `welded_in_object_frame`, `plane_tags`) is spelled out (and mis-formatted, e.g. `origin: [0.0; 3],        instance_meta: None, ...`). Adding a `Mesh` field touches every processor; the ones that forget a semantic default are exactly the bug class `Mesh::rebuilt_like` (`mesh.rs:295`) was introduced to avoid.
- Fix: `Mesh::from_buffers(positions, normals, indices)` and use it.
- Effort: S

### PROC-25: `profile::create_circle` / `calculate_circle_segments` / `ProfileType` are public but production-unused and use a different policy
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `profile.rs:208-310`; only callers are `extrusion.rs` tests (`:544,563,585`)
- What: a second circle-profile builder with radius-adaptive 8..32 segments, while the real IfcCircleProfileDef path uses 36 (`shapes.rs:80`). Wide `pub` surface invites the wrong one being used.
- Fix: delete (tests can build via `ProfileProcessor` or a `#[cfg(test)]` helper), or make it the single circle builder used by `shapes.rs`.
- Effort: S

### PROC-26: `create_cap_mesh` infers winding from `z == 0.0` rather than from its `normal` argument
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `extrusion_generic.rs:155-184` (`if z.value() == 0.0 { reversed }`), callers `extrusion.rs:83-84,157-163,215-226`
- What: the cap's facing is decided by an exact float compare on the plane height, while the caller passes the intended normal separately. `create_partial_void_geometry` has to emit a `-Z` cap at a non-zero depth and then manually swap every triangle (`extrusion.rs:222-226`) to compensate. Any future caller extruding from a non-zero base (or with `-0.0`) gets the opposite winding silently. Relatedly, `create_partial_void_geometry:212-215` (`extrusion.rs:214`) returns `Ok(())` when the void's own triangulation fails *after* `extrude_profile_with_voids` (`extrusion.rs:135-150`) already opened the outer cap(s) for that void → an open mesh.
- Fix: take an explicit `facing: CapFacing { Up, Down }` (or derive from `normal.z`); on partial-void triangulation failure, error out (or don't add the cap hole).
- Effort: S

### PROC-27: Point-coincidence / seam tolerances are scattered literals with no named home
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `profiles/outline.rs:144-146` (`1e-9`), `:205` (`SEAM_TOL = 1e-6`), `:243` (`1e-9`), `:351` (`1e-9`); `profiles/directrix.rs:17` (`PARAM_EPS 1e-9`), `:232` (`JUNCTION_EPS 1e-6`); `profiles/mod.rs:505,525,592` (`1e-9`); `profiles/simplify.rs:313,449` (`1e-9`); `processors/swept/disk.rs:15` (`TUBE_DEDUPE_EPS 1e-9`); `swept/surface_curve.rs:114` (`1e-9`); `profiles/placement.rs:52,68-71` (`1e-10`); `profile_extractor.rs:713` (`1e-10`); `profiles/mod.rs:812` (`1e-12`); `extrusion.rs:201` (`PARTIAL_VOID_EPSILON = 0.001`, file units); `extrusion_generic.rs:139` (`0.001` floor commented as "1 mm" but in file units, i.e. 1 µm in mm-authored files); `processors/extrusion.rs:54` (`0.001` direction tolerance)
- What: the same notion ("two profile/curve points are the same") uses 1e-6, 1e-9, 1e-10 and exact equality in different files, all in *file units* (so they mean different physical distances in mm vs m files); `PARTIAL_VOID_EPSILON` and the aspect-ratio "1 mm" floor are absolute file-unit constants commented as if they were metres.
- Fix: a `geometry::tolerance` module with named, documented constants (`POINT_EQ_REL`, `CURVE_JUNCTION`, …) and, where the intent is physical, scale by `length_unit_scale` like `simplify.rs:429` already does.
- Effort: S

### PROC-28: Long functions in profiles/swept/tessellated/extractor (line counts approximate, include trailing docs)
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `processors/swept/revolved.rs:31` `process` (~245 lines), `processors/tessellated/triangulate.rs:12` `triangulate_polygon` (~218 lines incl. a closure with its own normal math), `profile_extractor.rs:86` `extract_profiles_with_diagnostics` (~148), `:234` `extract_mapped_item_profiles` (~142, 10 parameters + `#[allow]`-free arg list), `:387` `extract_extruded_solid` (~123), `profiles/curves_2d.rs:287` `process_indexed_polycurve` (~149) and its twin `profiles/curves_3d.rs:473` (~126), `profiles/curves_3d.rs:64` `read_conic_placement_3d` (~130, five nesting levels of `if let`), `profiles/mod.rs:481` `process_composite_curve_3d_with_depth` (~125, seven nesting levels), `profiles/curves_2d.rs:70` `process_trimmed_conic` (~124), `rect_fast.rs:220` `subtract_rect_openings` (~107); `profiles/mod.rs` is 830 lines mixing dispatch, composite walking, trimming and placement helpers
- What: most of the length is the duplicated scaffolding listed in the DRY findings above (attribute ladders like `if let Some(a) = e.get(i) { if !a.is_null() { if let Some(x) = decoder.resolve_ref(a)? { ... } else { default } } else { default } } else { default }` appear >30 times in the area). `profile_extractor` functions pass 8-10 loose parameters (`element_id, ifc_type, item, elem_tf, unit_scale, profile_processor, decoder, model_index, depth, results, skipped`) instead of a context struct.
- Fix: a `DecodedEntity::opt_ref(idx, decoder) -> Result<Option<DecodedEntity>>` helper in core removes most ladders; an `ExtractCtx` struct for the extractor; split revolved into ring-building / stitching / capping (shared with PROC-9).
- Effort: M


## Helper findings index

Full text in `/home/louistrue/rust-review/02a-proc-boolean-brep-surface.md` (PROC-S*) and `/home/louistrue/rust-review/02b-proc-alignment-sectioned-voids.md` (PROC-AL-*).

| ID | Severity | Title |
|---|---|---|
| PROC-S1 | High | Three independent IFC curve samplers that have drifted (plus a polyline-only PBHS boundary parser) |
| PROC-S2 | High | Spurious `(0,0,0)` point appended to every clamped B-spline sampled by `sample_curve_polyline` |
| PROC-S3 | High | Face-bound classification and loop extraction exist 3 times with different outer-ring rules |
| PROC-S4 | High | Planar-face triangulation exists 3 times; the faceted copy's fast paths drifted from `triangulate_polygon` |
| PROC-S5 | Medium | FacetedBrep fills authored holes when hole triangulation fails |
| PROC-S6 | Medium | `IfcFacetedBrepWithVoids` has no processor, and `SurfaceOfLinearExtrusionProcessor` is never registered |
| PROC-S7 | Medium | Four forks of IfcAxis2Placement/IfcAxis1Placement parsing; the conics fork bypasses `build_axis2_matrix` and misreads 2D placements |
| PROC-S8 | Medium | Copy-pasted vector/2D-polygon primitives: Newell normal, perpendicular basis, signed area, point-in-ring |
| PROC-S9 | Medium | The `(x,y,z)`-from-coordinate-list read is repeated at 14 sites, and vertex resolution is strict in one place and lenient in another |
| PROC-S10 | Medium | Concave quads are fanned across the wrong diagonal in faceted Breps and surface models |
| PROC-S11 | Medium | STEP boolean/logical parsing is hand-rolled at 11 sites in this sub-area, with different semantics |
| PROC-S12 | Medium | Mesh assembly and processor scaffolding copy-pasted per processor |
| PROC-S13 | Medium | Duplicated tessellation snippets: grid indices, largest-gap angular extent, circle vs ellipse samplers, ribbons |
| PROC-S14 | Medium | Boolean module: AABB/diagonal helpers repeated, and tolerances are absolute file-unit floors whose comments assume metres |
| PROC-S15 | Medium | Recursion/walk guards reimplemented with different limits and failure semantics |
| PROC-S16 | Medium | `SameSense=.F.` flips loop-derived planar triangulations, where the loops already give the face normal |
| PROC-S17 | Medium | A malformed half-space returns `Err` through `?`, which deletes the boolean host |
| PROC-S18 | Medium | The PBHS boundary accepts only `IfcPolyline`, so other boundaries fall back to an unbounded over-cut |
| PROC-S19 | Medium | `IfcBoxedHalfSpace` is treated as an unsupported solid operand |
| PROC-S20 | Medium | B-spline advanced faces ignore the face's bounds, so trimmed NURBS faces render as untrimmed patches |
| PROC-S21 | Medium | Unresolvable points are silently skipped rather than refusing the curve |
| PROC-S22 | Medium | Advanced-face dispatch is stringly typed and allocates `to_uppercase()` on already-uppercase strings |
| PROC-S23 | Low | SurfaceOfLinearExtrusion produces NaN on a zero direction and has no RTC hook |
| PROC-S24 | Low | Surface of revolution ignores `IfcSweptSurface.Position` |
| PROC-S25 | Low | AdvancedBrep aborts the whole solid when one face fails to decode |
| PROC-S26 | Low | Hot-path inefficiencies in the face and curve paths |
| PROC-S27 | Low | Stale or self-contradicting documentation |
| PROC-S28 | Low | God functions and module size |
| PROC-S29 | Low | Dead code, an overly wide public API, and redundant guards |
| PROC-S30 | Low | `partial_cmp().unwrap_or(Equal)` in `sort_by` on file-derived angles |
| PROC-S31 | Low | Copy-pasted test fixtures and checks with conflicting semantics |
| PROC-S32 | Low | Magic point-coincidence and parameter tolerances scattered through curve sampling |
| PROC-AL-1 | Medium | IfcRelVoidsElement / IfcRelAggregates / IfcRelAssociatesMaterial decoding duplicated between geometry scanners and the processing span pre-pass (drifted) |
| PROC-AL-2 | Medium | Alignment station sampling with a cap is implemented three times; two copies are verbatim |
| PROC-AL-3 | Medium | Three numerical spiral/clothoid integrators with different quadrature and accuracy |
| PROC-AL-4 | Medium | Vertical circular arc evaluated two ways; the IFC4x1 copy is a parabola with a false accuracy claim |
| PROC-AL-5 | Medium | IfcSectionedSolidHorizontal drops profile holes (hollow sections render solid) |
| PROC-AL-6 | Medium | ArcLengthMap does full horizontal evaluation per step; O(V) vertical scan makes it quadratic on sampled curves; unit-naive step |
| PROC-AL-7 | Medium | Duplicated bounded curve-walk budget (MAX_CURVE_NODES ×2 plus a literal) |
| PROC-AL-8 | Medium | Strict alignment validation re-walks placements and curve segments the canonical resolvers walk again |
| PROC-AL-9 | Low | Boolean attribute reading re-implemented 7× |
| PROC-AL-10 | Low | IfcDirection / IfcCartesianPoint parsing re-implemented across the sub-area |
| PROC-AL-11 | Low | Placement matrix applied to alignment samples by hand twice |
| PROC-AL-12 | Low | "Find the first IFCPROJECT id" scan duplicated |
| PROC-AL-13 | Low | `ifc_type_fn!` OnceLock + `from_str` cache is unnecessary; the variants exist |
| PROC-AL-14 | Low | STEP binary decoding and `hex_val` live in the texture module instead of core |
| PROC-AL-15 | Low | Typed `IFCPARAMETERVALUE` detection duplicated; the circle parameter ignores angle units |
| PROC-AL-16 | Low | Horizontal arc accepts an infinite radius; non-strict path emits NaN vertices |
| PROC-AL-17 | Low | Sectioned sort uses `partial_cmp().unwrap_or(Equal)` |
| PROC-AL-18 | Low | Vertical segments assumed sorted but never sorted (IFC4x1) |
| PROC-AL-19 | Low | `compute_parts_to_skip` rebuilds MaterialLayerIndex with an extra full-file scan |
| PROC-AL-20 | Low | Unit-blind "file unit ≈ metre" constants; the stated justification is stale |
| PROC-AL-21 | Low | Stale or contradictory docs in alignment.rs |
| PROC-AL-22 | Low | Other stale docs in the sub-area |
| PROC-AL-23 | Low | Alignment processing errors are silently swallowed |
| PROC-AL-24 | Low | IFC4x3 directrix sampling hard-codes `TessellationQuality::Medium` and rebuilds `IfcSchema` per parse; no per-directrix cache |
| PROC-AL-25 | Low | `MaterialLayerIndex::from_flat` cursor arithmetic can wrap on wasm32 |
| PROC-AL-26 | Low | Texture index casts `i64 as u32` and decodes per-pixel `Vec`s |
| PROC-AL-27 | Low | God functions and file sizes |
| PROC-AL-28 | Low | Copy-pasted test fixtures |
| PROC-AL-29 | Low | Two different composite-curve sampling paths feed the alignment |
| PROC-AL-30 | Low | `AlignmentAxis::from_content` builds a full entity index per handle |

## Cross-cutting themes (own + helper findings)

1. **One router-free IFC primitive reader.** These findings describe one root cause:
   - PROC-1, PROC-13, PROC-10
   - PROC-S7, PROC-S9, PROC-S21
   - PROC-AL-10, PROC-AL-11, PROC-AL-12

   Point, direction, Axis1/Axis2 placement, coordinate list and Position are read with different defaults and error policies. Create one `transform`/`ifc_read` module that returns `Result` values with a single null/default policy, and delete the forks: `processors/helpers.rs`, `GeometryRouter::parse_*`, `operator::parse_direction_ratios`, the `profile_extractor` copies, `curves_3d::read_conic_placement_3d`, `conics::read_axis2_placement_3d`, `sectioned_positions::read_direction`, and the alignment validators.

2. **One curve sampler.** These findings describe one root cause:
   - PROC-5, PROC-6, PROC-7, PROC-8, PROC-11
   - PROC-S1, PROC-S2, PROC-S13, PROC-S15, PROC-S18, PROC-S22
   - PROC-AL-3, PROC-AL-4, PROC-AL-7, PROC-AL-29

   The work involved:
   - Build one `sample_curve(entity, ctx)` covering line, conic, trimmed, polyline, indexed polycurve, composite, IFC4x3 curve segments and B-spline.
   - Give it one `WorkBudget` (in `ifc_lite_core::limits`), one junction-dedup tolerance, and one arc-density policy.
   - Derive 2D profile outlines, directrices, advanced-face edges, PBHS boundaries, surface-of-extrusion profiles and alignments from it.
   - Extend `trimmed_curve::decode_trimmed_primitive` to ellipse and polyline bases and make it the only trim interpreter.

3. **One ring/sweep mesher with the outward rule.** These findings describe one root cause:
   - PROC-4, PROC-9, PROC-17, PROC-22, PROC-24, PROC-26
   - PROC-S12
   - PROC-AL-5

   Extrusion, loft, revolve, swept disk, surface-curve sweep and sectioned solids all stitch rings and caps by hand. Only `extrusion_generic` applies `outward_is_right_hand`, and three of these meshers drop profile holes. A single `sweep_rings` in `extrusion_generic` would close the hole bugs and the winding drift together. Add `Mesh::from_buffers` and a single flat-shade builder alongside it.

4. **One planar-face triangulator.** These findings describe one root cause:
   - PROC-18
   - PROC-S3, PROC-S4, PROC-S5, PROC-S10, PROC-S16

   Face-bound classification, Newell normal, dominant-axis projection, quad fans and the hole-failure fallback exist in tessellated/, brep/faceted, brep/surface_model and advanced_face/bounds, each with different rules. `triangulation.rs` already has `calculate_polygon_normal`, `project_to_2d` and `triangulate_polygon_with_holes`. Make every face path call them, and never fan a quad without a convexity check.

5. **Fast-path vs general-path parity.** Each fast path should either defer to the general path on anything it does not prove, or share its parser.
   - CoordIndex raw bytes vs `parse_index_list` (PROC-14).
   - `PnIndex` handled on one face-set type only (PROC-3).
   - rect_fast vs the exact kernel: the geometry agrees, but the cost bound and telemetry are wrong (PROC-16, PROC-21).
   - `VoidIndex` vs the processing prepass (PROC-AL-1).
   - The IFC4x1 alignment evaluator vs the 4x3 gradient evaluator (PROC-AL-3, PROC-AL-4, PROC-AL-18).
   - `profile_extractor` vs the mesh path (PROC-2).

6. **Logical and enum decoding in core.** PROC-12, PROC-S11 and PROC-AL-9 together cover about 20 sites. Add `AttributeValue::as_logical()` / `DecodedEntity::get_bool(idx)` in `ifc_lite_core`. Use the same treatment for typed values such as `IFCPARAMETERVALUE` (PROC-AL-15) and for the STEP binary decode (PROC-AL-14).

7. **Units-aware tolerances.** These findings share one root cause:
   - PROC-27
   - PROC-S14, PROC-S32
   - PROC-AL-6, PROC-AL-20

   Absolute constants in file units are commented as if they were metres. Add a `geometry::tolerance` module whose physical constants are scaled by `decoder.length_unit_scale()`, as `profiles/simplify.rs:429` already does.

8. **Shared test support.** PROC-20, PROC-S31 and PROC-AL-28 all point the same way. Move `mesh_volume`, `signed_volume`, `open_edges`, `surface_area`, `Rng`, STEP fixture builders and a `mesh_of::<P>(step, id)` helper into `test_support.rs`, plus `tests/common` for integration tests.

## Concept inventory

**Vector/matrix math**
- `extrusion_local_transform` (extrusion shear/flip, generic) — `processors/extrusion.rs:35`
- inline copy of the extrusion shear — `processors/extrusion_tapered.rs:125-141`
- `build_tube_rmf` (rotation-minimising frame) — `processors/swept/disk.rs:43`
- `directrix_is_sweepable` — `processors/swept/disk.rs:21`
- `compute_frame` — `processors/sectioned.rs:310`
- `straight_y_frame` — `processors/sectioned.rs:292`
- `transform_outer` — `processors/sectioned.rs:405`
- `compute_face_normal` — `processors/sectioned.rs:586`
- `lerp_position` / `lerp_direction` / `interpolate_profile` — `processors/sectioned.rs:494/515/458`
- `AlignmentFrame` — `alignment.rs:197`
- `convert_ifc_to_webgl` (Z-up→Y-up, f32) — `profile_extractor.rs:735`
- `scale_translation` — `profile_extractor.rs:722`
- `LayerAxis::unit_vector` — `material_layer_index.rs:41`
- manual cross product — `alignment_sampling_placement.rs:59-63`
- manual triangle normals — `processors/tessellated/mesh_build.rs:129,189,257`, `processors/tessellated/triangulate.rs:87`, `rect_fast.rs:159,350`

**Transforms/placements**
- `parse_axis2_placement_3d` / `parse_cartesian_point` / `parse_direction` / `get_axis2_placement_transform_by_id` / `get_direction_by_id` — `processors/helpers.rs:31/83/121/172/213`
- `parse_axis2_placement_3d` / `build_axis2_matrix` / `parse_cartesian_point(_from_id)` / `parse_direction(_from_id)` / `parse_axis2_placement_3d_from_id` — `transform.rs:26/77/134/186/225/233/286`
- `parse_axis2_placement_2d` — `transform/placement_2d.rs:14`
- `GeometryRouter::parse_*` — `router/transforms/parsers.rs:16/61/100`
- `parse_direction_ratios` — `router/transforms/operator.rs:234`
- `parse_axis2_placement_3d` / `parse_cartesian_point` / `parse_direction_entity` / `parse_extrusion_direction` / `get_placement_recursive` / `resolve_present_ref` — `profile_extractor.rs:603/647/677/691/525/579`
- `read_conic_placement_3d` — `profiles/curves_3d.rs:64`
- `apply_profile_position` / `apply_cartesian_transformation_operator_2d` / `get_placement_2d` — `profiles/placement.rs:13/104/214`
- `axis2_placement_location_and_x_axis_3d` — `profiles/mod.rs:782`
- `read_axis2_placement_3d` — `processors/advanced_face/conics.rs:13`
- `read_placement` — `curve_segment.rs:101`
- `circle_basis` — `curve_source.rs:188`
- `validate_placement` / `validate_vector` — `alignment_sampling_placement.rs:11/78`
- `AlignmentAxis::evaluate` — `alignment_sampling.rs:160`

**Tolerances/epsilons/limits**
- `MAX_CURVE_DEPTH=50`, `MAX_CURVE_NODES=100_000`, `MAX_PROFILE_DEPTH=16` — `profiles/mod.rs:39,53,65`
- `MAX_CURVE_NODES` — `processors/curve_walk.rs:17`
- `100_000` literal — `alignment_sampling_curve.rs:11`
- `PARAM_EPS=1e-9`, `JUNCTION_EPS=1e-6` — `profiles/directrix.rs:17,232`
- `CHORD_TOL_M=5e-4` — `profiles/curves_2d.rs:143` and `profiles/directrix.rs:265`
- `SEAM_TOL=1e-6` — `profiles/outline.rs:205`
- 1e-9 dedup — `profiles/outline.rs:144,243,351`
- simplify constants (`SMOOTH_CURVE_*`, `RDP_EPSILON_*`, `THIN_FEATURE_RATIO`, …) — `profiles/simplify.rs:21-84`
- `TUBE_DEDUPE_EPS=1e-9` — `processors/swept/disk.rs:15`
- `PARTIAL_VOID_EPSILON=0.001` — `extrusion.rs:201`
- aspect ratio 10000, 0.001 floor — `extrusion_generic.rs:139,150`
- z-alignment 0.001 — `processors/extrusion.rs:54`
- `MAX_FAST_OPENINGS=128` — `rect_fast.rs:233`
- `PLANE_TOL=1e-4` — `rect_fast.rs:165`
- `near_eps` 2^-21 — `rect_fast.rs:253`
- `SNAP_GRID` (import) — `rect_fast.rs:34`
- `MAX_MAPPED_DEPTH=3` — `profile_extractor.rs:222`
- `SAMPLE_STEP_FILE_UNITS` / `MAX_SAMPLES` / `RIBBON_HALF_WIDTH_FILE_UNITS` — `processors/alignment.rs:48/53/58`
- `MAX_ANGLE_STEP_RAD` / `MAX_SUBDIVISIONS` — `processors/sectioned.rs:76/80`
- `MAX_OUTPUT_SAMPLES` / `MAX_DIAGNOSTICS` — `alignment_sampling.rs:13/14`
- `MAX_TEX_DIM=16384` — `processors/texture/raster.rs:49`
- `MAX_HEADER_BYTES` — `processors/texture/raster_header.rs:4`

**Unit conversion**
- `detect_unit_scale` — `profile_extractor.rs:747`
- `length_unit_scale()` use — `profiles/curves_2d.rs:146`, `profiles/directrix.rs:267`, `profiles/mod.rs:303`, `profiles/simplify.rs:429`
- `plane_angle_to_radians()` use — `profiles/curves_2d.rs:96`, `profiles/curves_3d.rs:291`, `profiles/directrix.rs:78`, `processors/swept/revolved.rs:81`, `alignment.rs:269`
- `resolve_scale` — `alignment_sampling.rs:198`

**Bbox/AABB**
- `AlignedBox` / `aligned_box` — `rect_fast.rs:132/140`
- `Profile2D::center_on_bbox` — `profile.rs:46`
- bbox loop — `profiles/simplify.rs:326`
- `profile_has_extreme_aspect_ratio` — `extrusion_generic.rs:117`

**Hashing**
- None defined in the area. Only `FxHashMap`/`HashMap` containers are used, e.g. `void_index.rs`, `material_layer_index.rs`, the texture index.

**Triangulation/polygon ops**
- `extrude_profile` / `extrude_profile_watertight` / `extrude_profile_with_voids` / `extrude_profile_lofted` / `create_partial_void_geometry` / `match_loop_lengths` / `resample_loop` / `create_lofted_side_walls` / `apply_transform` — `extrusion.rs:18/37/118/246/208/313/328/373/425`
- `triangulate_polygon` (Newell, dominant-axis projection, earcut, quad fan) — `processors/tessellated/triangulate.rs:12`
- `orient_closed_shell_outward` / `build_flat_shaded_mesh(_with_uvs)` — `processors/tessellated/mesh_build.rs:80/157/231`
- `build_tube` — `processors/swept/disk.rs:152`
- `sweep_profile_along_frames` — `processors/swept/surface_curve.rs:168`
- `build_uv_sphere` — `processors/sphere.rs:83`
- `build_cellular` / `dedup_axis` / `subtract_rect_openings` — `rect_fast.rs:400/327/220`
- `rounded_rectangle_outline` / `push_arc` / `round_corner` / `fillet_outline` / `approximate_arc_3pt_3d` / `trim_polyline` / `same_point_3d` / `push_dedup` — `profiles/outline.rs:162/254/283/325/56/14/141/240`
- `approximate_arc_3pt` — `profiles/curves_2d.rs:436`
- `simplify_smooth_curve_polyline` / `rdp_simplify_open` / `closed_loop_self_intersects` / `loop_doubles_back` / `perpendicular_distance` / `mirror_profile_about_y_axis` — `profiles/simplify.rs:300/125/183/252/108/93`
- `emit_cap` / `emit_side_walls` — `processors/sectioned.rs:529/558`
- `create_circle` / `calculate_circle_segments` / `create_rectangle` — `profile.rs:261/299/252`

**Entity attribute access/decoding**
- `extract_coord_index_bytes` / `validate_coord_index_structure` — `processors/mod.rs:76/154`
- `read_point_list` — `processors/tessellated/mod.rs:31`
- `parse_index_loop` / `parse_face_inner_indices` — `processors/tessellated/polygonal.rs:20/40`
- `extract_trim_select` / `TrimSelect` — `profiles/curves_2d.rs:21` / `profiles/mod.rs:60`
- `trim_to_angle_3d` — `profiles/curves_3d.rs:343`
- `require_positive` — `profiles/steel_shapes.rs:20`
- `read_bool` — `alignment.rs:125`, `processors/texture/mod.rs:189`
- inline `.T.` parsing — see PROC-12
- `PositionAlongDirectrix::parse` — `processors/sectioned_positions.rs:58`
- `read_direction` — `processors/sectioned_positions.rs:162`
- `validate_primitive` — `alignment_sampling_curve.rs:133`
- `CurveWalk::spend` — `processors/curve_walk.rs:50`
- `ProfileProcessor::spend_curve_node` — `profiles/mod.rs:101`
- `ifc_type_fn!` — `alignment.rs:40`
- `decode_step_binary` / `hex_val` — `processors/texture/raster.rs:16/36`
- `extract_profiles(_with_diagnostics)` — `profile_extractor.rs:82/86`
- relationship indexes:
  - `MaterialLayerIndex::{from_content, from_spans, insert_association, to_flat, from_flat}` — `material_layer_index.rs:141,170,181,229,269`
  - `resolve_layer_set_usage` — `material_layer_index.rs:393`
  - `propagate_voids_via_aggregates` / `build_aggregate_children_index` / `compute_parts_to_skip` / `VoidIndex` — `void_index.rs:35/93/225/248`

**Colour/style resolution**
- `build_texture_index` / `resolve_triangle_texture_map` / `resolve_surface_texture` — `processors/texture/mod.rs:313/240/214`
- texture types: `MeshTexture`, `TextureSource`, `ImageTextureRef`, `TextureAttachment`, `ResolvedTextureMap` — `processors/texture/mod.rs:34-79`
- UV V-flip — `processors/tessellated/mesh_build.rs:295`
- `LayerInfo.material_id` — `material_layer_index.rs:56`

**Error types**
- `crate::Error::geometry(String)` is used throughout, plus `Error::InvalidExtrusion` / `InvalidProfile` / `TriangulationError` in `extrusion.rs` and `profile_generic.rs`.
- `Option`-only failure paths: `curve_segment.rs`, `gradient.rs`, texture, `rect_fast` (`None` = defer).
- `std::result::Result<_, ()>` in `profile_extractor.rs:579`.
- `SkippedProfile` — `profile_skip.rs`
- `RectFastStats` — `rect_fast.rs:45`
- `AlignmentSamplingDiagnostic{,Code}` — `alignment_sampling.rs:57,64`
- `BoolFailure` (via `CsgSolidProcessor`) — `processors/csg_primitive.rs:112`

(Inventory covers this file and 02b; `02a-proc-boolean-brep-surface.md` carries its own inventory for boolean/advanced_face/brep/surface.)
