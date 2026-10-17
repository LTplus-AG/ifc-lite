I found 30 findings across the alignment, sectioned-solid, void/material-index and texture code; nothing is High severity. Every finding was checked against the code with rg/sed/cat. I ran no cargo command, edited nothing and wrote no output file, so the report is below rather than at a path.

# PROC (alignment / sectioned / void+material index / texture) sub-area review

## Summary
- **Relationship indexing is implemented twice and the copies have drifted.** One copy is the scanner path in `void_index.rs` / `material_layer_index.rs`; the other is the span path in `rust/processing/src/prepass.rs`. The opening order is sorted to fix #2019 in only one of them. `VoidIndex` is never used in production, only in tests.
- **Sampling stations along an alignment (with a sample cap) is written three times**, and two copies have identical constants. The placement transform for alignment samples is hand-written twice. A wasm comment says the ribbon processor was removed; it is still registered and used by the router.
- **Curve maths is duplicated with different accuracy.** There are three clothoid/spiral integrators (trapezoid, Simpson, Gauss). Vertical circular arcs are evaluated exactly in `gradient.rs` but with a parabola in `alignment.rs`, and the "sub-millimetre for R > 500 m" claim is wrong: about 0.1 m error at s = 100 m.
- **Bug: `IfcSectionedSolidHorizontal` ignores profile holes.** Hollow cross-sections such as box girders render solid, although the holes are interpolated.
- **Bug (LIKELY): an `IfcParameterValue` station on an `IfcCircle` is assumed to be in radians.** The sibling code in `profiles/curves_2d.rs` scales by `plane_angle_to_radians()`.
- **Perf: `ArcLengthMap` is far more expensive than it needs to be.** It evaluates the full horizontal geometry three times per step just to read the slope. Combined with an O(n) vertical-segment scan and 1-file-unit steps, mm-unit files get millions to billions of evaluations. The map is also always built for non-gradient IFC4x3 bases, even planar ones.
- **Tolerances and helpers are scattered.**
  - "Unit is metres" constants appear in 6+ places, even though `decoder.length_unit_scale()` exists.
  - `MAX_CURVE_NODES = 100_000` is defined twice, plus a third `100_000` literal; none of them is in `core::limits`.
  - There are 7 hand-written `== "T"` boolean readers.
  - IfcDirection / IfcCartesianPoint parsing is re-implemented 5+ times.
- **Stale docs:** the transition-curve module doc, the "~538" line reference, "NOTE above decode_step_binary", "now-removed ribbon processor", and the `ifc_type_fn!` justification.

## Findings

### PROC-AL-1: IfcRelVoidsElement / IfcRelAggregates / IfcRelAssociatesMaterial decoding duplicated between geometry scanners and the processing span pre-pass (drifted)
- Category: DRY | Severity: Medium | Confidence: CONFIRMED
- Where:
  - Voids: `rust/geometry/src/void_index.rs:286-299` (`VoidIndex::from_content`, `decode_at`) and `rust/processing/src/prepass.rs:228-233` (spans, `decode_at_with_id`).
  - Aggregates: `rust/geometry/src/void_index.rs:93-130` (`build_aggregate_children_index`, `get(5).as_list().filter_map`) and `rust/processing/src/prepass.rs:243-257` (`get_refs(5)`).
  - Material association: `rust/geometry/src/material_layer_index.rs:196-207` and `rust/processing/src/prepass.rs:212-223`.
  - LayerSetUsage → LayerSet → Layer walk: `material_layer_index.rs:393-477` and `rust/processing/src/style/material.rs:195-201`.
- What: the same "attr 4/5 of rel X" fold is written once per driver.
- Drift:
  1. `prepass.rs:268-270` sorts openings per host (#2019); `VoidIndex` keeps file order and never propagates voids through aggregates.
  2. `get_refs` (core `schema_gen.rs:336`) accepts a single scalar ref; the geometry copies require a list.
  3. Material precedence differs: prepass is last-wins (`insert`); `MaterialLayerIndex` is first-Sliceable-wins.
  4. Zero-thickness layers are dropped in `material_layer_index.rs:455-459` but kept in `style/material.rs`.
- Why: regression tests `rust/geometry/tests/issue_582_583_regression_test.rs:80` and `issue_584_smiley_west_test.rs:81` exercise `VoidIndex`, which is not what production runs. A fix to one fold silently misses the other.
- Fix: follow the pattern `MaterialLayerIndex::insert_association` already uses (`material_layer_index.rs:181`). Add `fold_void_rel(&DecodedEntity, &mut map)` and `fold_aggregate_rel(...)` in `void_index.rs`, call them from both the scanner and the span drivers, and move the #2019 sort into the shared kernel. Delete `VoidIndex` (production-dead) or make it a thin wrapper over the shared kernel.
- Effort: M

### PROC-AL-2: Alignment station sampling with a cap is implemented three times; two copies are verbatim
- Category: DRY | Severity: Medium | Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/processors/alignment.rs:48-53,93-108` (`SAMPLE_STEP_FILE_UNITS=1.0`, `MAX_SAMPLES=5_000`).
  - `rust/wasm-bindings/src/api/alignment_lines.rs:37-38,141-153`: identical constants and code.
  - `rust/geometry/src/alignment_sampling.rs:278-295`: metre spacing, default cap 5_001, plus an endpoint/coarsening policy.
- What: the same "ceil(L/step), cap, fall back to L/MAX, clamp last to L" logic. The copies already differ: 5_000 segments vs 5_001 samples, file units vs metres, `min(length)` clamp vs explicit last sample. The wasm comment at `alignment_lines.rs:33-36` says it "Mirrors the (now-removed) ribbon processor", but `IfcAlignmentProcessor` is still registered (`router/processor_registry.rs:41,65`) and called from `router/processing.rs:142,1119`.
- Why: changing the step or cap in one place leaves the overlay and the mesh sampled differently.
- Fix: add `AlignmentCurve::sample_stations(step, max_samples) -> impl Iterator<Item=f64>` in `alignment.rs` and use it from all three. Fix the stale comment.
- Effort: S

### PROC-AL-3: Three numerical spiral/clothoid integrators with different quadrature and accuracy
- Category: DRY | Severity: Medium | Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/alignment.rs:968-1019`: trapezoid, step 2 file units, `n∈[16,4096]`, re-integrated from 0 on every evaluation.
  - `rust/geometry/src/curve_segment.rs:63-80`: composite Simpson, 0.25-unit step, incremental.
  - `rust/landxml/src/alignment/numeric/geometry/clothoid.rs:39`: 8-point Gauss-Legendre with a domain cap.
  - Heading formula `θ=k0·s+½(k1−k0)s²/L` appears in both `alignment.rs:105` (`heading_integral`) and `clothoid.rs:33,39`.
- What: the same ∫(cos h, sin h) ds concept in three places. Trapezoid at h=2 m has O(h²κ²L) error (mm-level on R≈100 m transitions); Simpson is far more accurate. `alignment.rs` re-integrates from 0 on every `evaluate`, while `curve_segment.rs` deliberately avoids that ("quadratic in its sample count", `curve_segment.rs:67-68`).
- Why: IFC4x1 and IFC4x3 alignments of the same geometry disagree, and the slow path is hit hard by `ArcLengthMap` (PROC-AL-6).
- Fix: one `spiral_point(kappa: impl Fn(u)->heading, from, to)` Simpson integrator in `curve_segment.rs` (or a new `geometry/src/spiral.rs`), used by `HSeg::Transition` with the `TransitionKind::heading_integral` blend. Leave landxml separate unless a shared math crate appears.
- Effort: M

### PROC-AL-4: Vertical circular arc evaluated two ways; the IFC4x1 copy is a parabola with a false accuracy claim
- Category: DRY | Severity: Medium | Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/alignment.rs:1060-1074` (`VSeg::CircularArc` uses `z=h0+g0 s±s²/2R`), with the doc at `alignment.rs:181-184` and `1067-1068`.
  - Exact version: `rust/geometry/src/gradient.rs:180-185` (`circular_from_radius`).
  - `alignment.rs:1044-1059` (`Parabolic`) and `1060-1074` (`CircularArc`) are also byte-identical arms of each other.
- What: the doc says the parabola is "sub-millimetre" for R > 500 m over tens of metres. The neglected x⁴/8R³ term is 6 mm at s=50, R=500 and 0.1 m at s=100, R=500.
- Why: IFC4x1 and IFC4x3 crest/sag curves disagree; the doc misleads.
- Fix: make `circular_from_radius` `pub(crate)` and call it with `signed_radius = ±R` (IsConvex → negative). Collapse the Parabolic/CircularArc arms into one helper.
- Effort: S

### PROC-AL-5: IfcSectionedSolidHorizontal drops profile holes (hollow sections render solid)
- Category: Bug | Severity: Medium | Confidence: CONFIRMED
- Where: `rust/geometry/src/processors/sectioned.rs:219` (`transform_outer(&profile.outer, …)`), `:529-553` (`emit_cap` triangulates the outer ring only), `:558-584` (side walls use the outer ring only), and `:474-489` (holes interpolated but never used).
- What: `Profile2D.holes` (box-girder / hollow-rectangle cross-sections) is carried and lerped but never placed, stitched or used in cap triangulation.
- Why: hollow bridge decks and pipes render as solid prisms. The interpolation work is also wasted.
- Fix: place every hole ring with the same frame, stitch inner side walls with reversed winding, and triangulate caps with holes (the triangulator in `triangulation.rs` supports holes elsewhere). Until then, emit a diagnostic.
- Effort: M

### PROC-AL-6: ArcLengthMap does full horizontal evaluation per step; O(V) vertical scan makes it quadratic on sampled curves; unit-naive step
- Category: Perf | Severity: Medium | Confidence: LIKELY
- Where:
  - `rust/geometry/src/alignment_arc_length.rs:22,30-35`: three `alignment.evaluate(s)` calls per step to read only `tangent.z`.
  - `rust/geometry/src/alignment.rs:513-535`: linear scan over `self.vertical`.
  - `rust/geometry/src/processors/sectioned_positions.rs:115`: `along_horizontal` is false for any non-`IfcGradientCurve` basis.
  - `rust/geometry/src/processors/sectioned.rs:185-189`: the map is built whenever any position is not along-horizontal.
- What: speed depends only on vertical slope (√(1+g²)). Each `evaluate` also runs the transition integration (up to 4096 trig steps) and a linear vertical scan.
  - `IfcCompositeCurve` / `IfcPolyline` bases sampled by `from_sampled_curve` / `from_points` give one VSeg per sample (V of 10³–10⁴), so evaluating the map costs O(steps·V).
  - `step = max(1, L/1e5)` is in file units, so mm files get up to 100k steps. The doc ("at most 1 m apart") assumes metres.
  - For a planar `'FootPrint'` composite curve, z is constant, so the whole map is wasted.
- Why: worst case is about 10⁹ iterations on mm-unit road models.
- Fix:
  1. Expose `evaluate_vertical_frame` as `pub(crate)` and integrate `sqrt(1+g²)` directly.
  2. Sort vertical segments at parse time (as `gradient.rs:77` does) and use `partition_point`.
  3. Skip the map when every vertical segment has zero grade.
  4. Use `decoder.length_unit_scale()` for the step.
- Effort: S

### PROC-AL-7: Duplicated bounded curve-walk budget (MAX_CURVE_NODES ×2 plus a literal)
- Category: DRY | Severity: Medium | Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/processors/curve_walk.rs:17,28-63` (`MAX_CURVE_NODES`, `CurveWalk::spend`).
  - `rust/geometry/src/profiles/mod.rs:53,99-115`: a second `MAX_CURVE_NODES` and a Cell-based `checked_sub` charge.
  - `rust/geometry/src/alignment_sampling_curve.rs:11,71-77`: literal `100_000` and `charge_references`.
- What: three implementations of the same "work budget" from AGENTS.md "Bounding walks". AGENTS.md says to put shared bounds in `ifc_lite_core::limits`, which currently holds only `MAX_MAPPED_ITEM_DEPTH`, `MAX_PLACEMENT_DEPTH` and the coord threshold.
- Why: the budgets can drift; error messages and exhaustion semantics already differ (`exhausted` flag vs bare error).
- Fix: put `MAX_CURVE_NODES` in `ifc_lite_core::limits`, plus one `WorkBudget { left, exhausted }` type with `charge(n)`, used by all three.
- Effort: S

### PROC-AL-8: Strict alignment validation re-walks placements and curve segments the canonical resolvers walk again
- Category: DRY | Severity: Medium | Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/alignment_sampling_placement.rs:11-75`: placement chain walk with visited set and `MAX_PLACEMENT_DEPTH`, then `router/transforms/mod.rs:266-290` (`resolve_scaled_placement_strict`) walks the same chain again.
  - `rust/geometry/src/alignment.rs:250-258`: re-validates every gradient segment's placement that `validate_composite` (`alignment_sampling_curve.rs:46-47`) already validated.
- What: the strictness checks (only `IfcLocalPlacement`, only `Axis2Placement3D`, finite values, non-parallel axes) are a parallel traversal instead of a policy on the canonical walker. Drift: `validate_composite` accepts an `IfcCompositeCurveSegment` in a GradientCurve, but the second loop then fails it with "CurveSegment missing Placement" (`alignment_sampling_curve.rs:84-88`).
- Fix: add a `PlacementPolicy::Strict` mode to the router placement walk that reports those conditions, and delete the second gradient loop at `alignment.rs:253-257`.
- Effort: M

### PROC-AL-9: Boolean attribute reading re-implemented 7×
- Category: DRY | Severity: Low | Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/alignment.rs:125-127` (`read_bool`, default false)
  - `rust/geometry/src/processors/sectioned.rs:146-150` (default true)
  - `rust/geometry/src/processors/sectioned_positions.rs:130-134` (default true)
  - `rust/geometry/src/processors/texture/mod.rs:189-191` (`read_bool -> Option`)
  - `rust/geometry/src/processors/tessellated/polygonal.rs:148-152`
  - `rust/geometry/src/profiles/mod.rs:642-647`
  - `rust/geometry/src/profiles/curves_3d.rs:283-288`
- What: there is no `AttributeValue::as_bool()` / `DecodedEntity::get_bool(i)` in core.
- Fix: add `get_bool(idx) -> Option<bool>` to `DecodedEntity` in `rust/core/src/schema_gen.rs`, handling `.T.`/`.F.` and `.U.` → None, and use it with `unwrap_or(default)` at each site.
- Effort: S

### PROC-AL-10: IfcDirection / IfcCartesianPoint parsing re-implemented across the sub-area
- Category: DRY | Severity: Low | Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/processors/sectioned_positions.rs:162-174` (`read_direction`: no type check; zero-fills missing ratios)
  - `rust/geometry/src/alignment_sampling_curve.rs:133-158` (`validate_primitive`)
  - `rust/geometry/src/alignment_sampling_placement.rs:78-108` (`validate_vector`, nearly identical to `validate_primitive`)
  - `rust/geometry/src/alignment.rs:356-364,649-656` (point coordinates)
  - `rust/geometry/src/gradient.rs:137-157`
  - `rust/geometry/src/curve_segment.rs:101-125`
  - Canonical: `rust/geometry/src/transform.rs:134,186,225,286` (`parse_cartesian_point*`, `parse_direction*`). That itself is duplicated at `processors/helpers.rs:121`.
- Fix: route the lenient sites through `transform::parse_direction_from_id` / `parse_cartesian_point_from_id`. Add one `parse_finite_primitive(entity, expected_type, dim) -> Result<[f64;3]>` for the strict sampling path, replacing both `validate_primitive` and `validate_vector`.
- Effort: S

### PROC-AL-11: Placement matrix applied to alignment samples by hand twice
- Category: DRY | Severity: Low | Confidence: CONFIRMED
- Where: `rust/geometry/src/alignment_sampling.rs:169-179` (point and tangent) and `rust/wasm-bindings/src/api/alignment_lines.rs:154-158`. Similar code is at `processing/src/appearance/mapping.rs:269` and `export/src/landxml_terrain_tin.rs:49`. The geometry crate already has `scalar.rs:114` (`transform_point4`) for nalgebra.
- Fix: one `transform_point_col_major(&[f64;16], [f64;3])` and `transform_vector_col_major` in `geometry/src/transform.rs`.
- Effort: S

### PROC-AL-12: "Find the first IFCPROJECT id" scan duplicated
- Category: DRY | Severity: Low | Confidence: CONFIRMED
- Where: `rust/geometry/src/alignment_sampling.rs:108-114,240-247` (twice in one file); also `rust/core/src/decoder.rs:335,365`, `rust/geometry/src/router/mod.rs:300`, `profile_extractor.rs:750`, `wasm-bindings/src/api/alignment_lines.rs:82`, `processing/src/appearance/context.rs:22`.
- Fix: add a cached `EntityDecoder::project_id()` in core (the decoder already caches unit scales the same way).
- Effort: S

### PROC-AL-13: `ifc_type_fn!` OnceLock + `from_str` cache is unnecessary; the variants exist
- Category: Maintainability | Severity: Low | Confidence: CONFIRMED
- Where: `rust/geometry/src/alignment.rs:8-9,40-58`; `rust/geometry/src/alignment_axis.rs:24` (`IfcType::from_str("IFCALIGNMENTCURVE")` on every call, uncached).
- What: `IfcType::IfcAlignmentCurve`, `IfcAlignment2DHorizontal`, …, `IfcAlignment2DVerSegCircularArc` all exist in `rust/core/src/generated/schema.rs` (verified for all 10). The module doc's justification is stale.
- Fix: compare against the enum variants directly and delete the macro.
- Effort: S

### PROC-AL-14: STEP binary decoding and `hex_val` live in the texture module instead of core
- Category: DRY | Severity: Low | Confidence: CONFIRMED
- Where: `rust/geometry/src/processors/texture/raster.rs:16-43`, and `rust/core/src/step_encoding.rs:198-206` (jscpd clone).
- What: duplicated STEP lexical decoding. Drift: `embedded_raster_dimensions` (`raster.rs:159`) requires the unused-bits indicator to be `'0'`; `decode_step_binary` (`raster.rs:23-24`) silently skips any indicator and mis-decodes non-zero ones.
- Fix: move `decode_step_binary` to `ifc_lite_core::step_encoding` (next to `decode_ifc_string`), share `hex_val`, and reject or handle a non-zero indicator consistently.
- Effort: S

### PROC-AL-15: Typed `IFCPARAMETERVALUE` detection duplicated; the circle parameter ignores angle units
- Category: Bug | Severity: Low | Confidence: LIKELY
- Where: `rust/geometry/src/processors/sectioned_positions.rs:85-91` (`distance_along * radius`). The sibling `rust/geometry/src/profiles/curves_2d.rs:32-37,88-95` scales by `decoder.plane_angle_to_radians()` (#820).
- What: an `IfcCircle` parameter is a plane angle. In a degree-unit file the station is 57.3× too long. Detection is also duplicated: `eq_ignore_ascii_case` here, `==` in `curves_2d`.
- Fix: one `AttributeValue::typed_value("IFCPARAMETERVALUE")` helper in core, and multiply by `plane_angle_to_radians()` in the circle branch.
- Effort: S

### PROC-AL-16: Horizontal arc accepts an infinite radius; non-strict path emits NaN vertices
- Category: Bug | Severity: Low | Confidence: LIKELY
- Where: `rust/geometry/src/alignment.rs:691` (`if radius < 1e-12`) and `:952-964`.
- What: NaN/inf passes the check. An `inf` radius (literal `1.E400`) gives `cx = sx + inf*0 = NaN`. Strict mode also skips finiteness checks on the horizontal radius and on vertical `h0`/`g0`/`start`. `curve_segment.rs:93` uses `r > 1e-12`, which also lets inf through; transitions use `abs()`. The three tolerance checks are inconsistent.
- Fix: `if !(radius.is_finite() && radius > 1e-12)`, plus a finiteness check on every parsed scalar in strict mode.
- Effort: S

### PROC-AL-17: Sectioned sort uses `partial_cmp().unwrap_or(Equal)`
- Category: Bug | Severity: Low | Confidence: SUSPECT
- Where: `rust/geometry/src/processors/sectioned.rs:190-194`. Compare `alignment.rs:326` and `gradient.rs:77`, which use `total_cmp`.
- What: a NaN `distance_along` (e.g. inf×0 from the parameter path) gives a non-total order. Since Rust 1.81, `sort_by` may panic on such comparators.
- Fix: `a.1.distance_along.total_cmp(&b.1.distance_along)`.
- Effort: S

### PROC-AL-18: Vertical segments assumed sorted but never sorted (IFC4x1)
- Category: Bug | Severity: Low | Confidence: LIKELY
- Where: `rust/geometry/src/alignment.rs:534-535` ("segments are in station order"); `parse_vertical` at `:763-908` never sorts. `gradient.rs:77` does sort.
- What: authored out-of-order `IfcAlignment2DVerSeg*` produce the wrong "nearest after" segment in gap extrapolation.
- Fix: `segments.sort_by(|a,b| v_start(a).total_cmp(&v_start(b)))` at the end of `parse_vertical`. This also enables `partition_point` (PROC-AL-6).
- Effort: S

### PROC-AL-19: `compute_parts_to_skip` rebuilds MaterialLayerIndex with an extra full-file scan
- Category: Perf | Severity: Low | Confidence: CONFIRMED
- Where: `rust/geometry/src/void_index.rs:225-241` (`MaterialLayerIndex::from_content` at `:233`, `build_aggregate_children_index` scan at `:172`); caller `rust/wasm-bindings/src/api/mod.rs:751`. `get_or_build_material_layer_index` (`mod.rs:768-796`) already caches an index with a `find_keyword` bail-out.
- What: two extra full scans and decodes; the cached index and the keyword probe are bypassed.
- Fix: change the signature to `compute_parts_to_skip(content, decoder, &MaterialLayerIndex)`. Return early when `!index.has_any_sliceable()`, skipping the aggregate scan entirely.
- Effort: S

### PROC-AL-20: Unit-blind "file unit ≈ metre" constants; the stated justification is stale
- Category: Maintainability | Severity: Low | Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/processors/alignment.rs:41-58`: "without needing a routing/unit-scale plumbing change". A mm file gets a 0.5 mm-wide ribbon.
  - `alignment.rs:994-997`: the doc says "roughly constant per metre", but the code uses one sample per 2 units.
  - `alignment_arc_length.rs:10-11,22`
  - `curve_segment.rs:23-26` (`MAX_STEP`)
  - `processors/sectioned.rs:76` (`MAX_ANGLE_STEP_RAD = 0.0349` written as a literal)
- What: `EntityDecoder::length_unit_scale()` (`rust/core/src/decoder.rs:358`) is available to every one of these through the `decoder` argument.
- Fix: express each as a metric constant divided by `decoder.length_unit_scale()`; use `2f64.to_radians()`.
- Effort: S

### PROC-AL-21: Stale or contradictory docs in alignment.rs
- Category: Maintainability | Severity: Low | Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/alignment.rs:14-18`: says Bloss/sine/cosine degrade to a clothoid, but `:102-119` implements them exactly.
  - `:78`: BiquadraticParabola is described as a "quintic smooth blend", but Bloss is cubic (`:67`).
  - `:668-670`: "sibling radius is guarded at ~538"; the guard is at `:691`.
  - `:8-9`: "Scope: IFC4x1"; IFC4x3 gradient/composite curves are handled too.
  - `:455-457`: "IfcPolyline directrix degenerated" is also emitted for sampled IFC4x3 curves.
- Effort: S

### PROC-AL-22: Other stale docs in the sub-area
- Category: Maintainability | Severity: Low | Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/processors/alignment.rs:68-77`: "attribute 7 … fallback window" and "expected IfcAlignmentCurve or IfcPolyline"; it now delegates to `locate_axis_curve`, which also accepts IFC4x3 curves.
  - `rust/geometry/src/processors/texture/mod.rs:196-197`: "NOTE above `decode_step_binary`"; the NOTE is at `mod.rs:103` and the function moved to `raster.rs`.
  - `rust/geometry/src/material_layer_index.rs:214-216`: says an element can be associated "once via its type", but a type association keys the type id, not the occurrence.
  - `rust/geometry/src/processors/sectioned_positions.rs:17`: "Structured IFC4x1 IfcDistanceExpression", but it also covers IFC4x3.
  - `rust/wasm-bindings/src/api/alignment_lines.rs:33-36`: see PROC-AL-2.
- Effort: S

### PROC-AL-23: Alignment processing errors are silently swallowed
- Category: Quirk | Severity: Low | Confidence: CONFIRMED
- Where: `rust/geometry/src/router/processing.rs:1127-1131` (`Err(_) => return Ok(None)`), `rust/wasm-bindings/src/api/alignment_lines.rs:110`, and `rust/geometry/src/processors/sectioned.rs:166-168` (degenerate profiles skipped silently).
- What: a malformed `IfcAlignmentCurve` (negative length, bad radius) disappears with no `diag_warn!`, unlike the vertical-degrade path (`alignment.rs:887-897`).
- Fix: emit `diag_warn!` with the entity id on the swallowed branch.
- Effort: S

### PROC-AL-24: IFC4x3 directrix sampling hard-codes `TessellationQuality::Medium` and rebuilds `IfcSchema` per parse; no per-directrix cache
- Category: Perf | Severity: Low | Confidence: CONFIRMED
- Where: `rust/geometry/src/alignment.rs:387-391,406-410` (`ProfileProcessor::new(IfcSchema::new())`), `rust/geometry/src/processors/sectioned.rs:152-153`.
- What:
  - The processor's `quality` is ignored for the directrix.
  - `IfcSchema::new()` builds HashMaps on every parse.
  - Each `IfcSectionedSolidHorizontal` re-parses and re-samples the shared `IfcGradientCurve`, and rebuilds the `ArcLengthMap`. IFC4x3 road models have many solids per directrix.
- Fix: pass quality and schema through; cache `Rc<(AlignmentCurve, Option<ArcLengthMap>)>` per directrix id in the processor.
- Effort: M

### PROC-AL-25: `MaterialLayerIndex::from_flat` cursor arithmetic can wrap on wasm32
- Category: Bug | Severity: Low | Confidence: SUSPECT
- Where: `rust/geometry/src/material_layer_index.rs:291-299,319`.
- What: `cursor + count` with `count = u32 as usize` (32-bit on wasm, overflow-checks off) can wrap past the bounds check. The NotSliceable branch adds `count` without any check. The input is internal (the JS pre-pass), so exposure is limited.
- Fix: `cursor.checked_add(count).filter(|&e| e <= len)`; require `count == 0` when `axis == 0`.
- Effort: S

### PROC-AL-26: Texture index casts `i64 as u32` and decodes per-pixel `Vec`s
- Category: Quirk/Perf | Severity: Low | Confidence: CONFIRMED
- Where: `rust/geometry/src/processors/texture/mod.rs:285-287` and `:162-176`.
- What:
  - A negative index wraps; consumers use `.get` (`processors/tessellated/mesh_build.rs:217-220`), so it is silently [0,0].
  - An index of 2³²+1 truncates to a valid index 1 instead of being rejected.
  - Each `IfcPixelTexture` pixel allocates a `Vec` via `decode_step_binary` (up to 16384² allocations).
- Fix: use `u32::try_from(v).ok()?` so a bad index rejects the whole map. Decode components into a stack `[u8;4]` with a non-allocating hex decoder.
- Effort: S

### PROC-AL-27: God functions and file sizes
- Category: Maintainability | Severity: Low | Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/alignment.rs`: 1080 lines (allowlisted at 1170).
    - `parse_horizontal` (`:594-754`): about 160 lines.
    - `parse_vertical` (`:763-908`): about 145 lines.
    - `parse_with_policy` (`:246-295`): a `strict` boolean threaded through four parsers.
  - `rust/geometry/src/processors/sectioned.rs::process` (`:102-280`): about 180 lines.
  - `compute_frame` (`:310-396`): computes the IFC4x3 axis condition twice (`:365`, `:392`).
  - `rust/geometry/src/alignment_sampling.rs::sample_alignment_axes` (`:217-339`): an immediately-invoked closure returning an anonymous `(SampledAlignmentAxis, bool, bool, bool)`.
  - `rust/geometry/src/void_index.rs`: 682 lines, about 290 of them inline tests (`:391-682`) instead of the house `void_index_tests.rs` sibling pattern. `material_layer_index.rs:479-563` is the same.
- Fix:
  - Split `alignment.rs` into `alignment_parse.rs` and `alignment_eval.rs`, with an `HSeg`/`VSeg` `start()`/`length()` method instead of `h_cum_start`, `h_length`, `v_start`, `v_length` (`:912-1037`).
  - Replace the bool tuple with a named struct.
  - Move the tests to sibling files.
- Effort: M

### PROC-AL-28: Copy-pasted test fixtures
- Category: DRY | Severity: Low | Confidence: CONFIRMED
- Where:
  - `rust/geometry/src/alignment_tests.rs:211-231,262-282,295-316,389-411`: the full STEP header plus `build_entity_index`/`decode_by_id(16)`/`parse` boilerplate each time. `alignment_sampling_tests.rs:6` already has a `model()` helper.
  - `rust/geometry/src/void_index.rs:468-514` duplicates `rust/geometry/tests/merge_layers_skip_test.rs:36-83` (jscpd).
  - `rust/geometry/tests/ifc4x3_sectioned_linear_positions.rs:37-58` duplicates `rust/wasm-bindings/src/api/alignment_lines_tests.rs:66-87`.
  - `rust/geometry/tests/issue_819_triangulated_normals.rs:39-55` duplicates `issue_828_sectioned_solid_horizontal.rs:27-43`.
- Fix: a `test_support::step_model(data_lines)` and `parse_alignment(content, id)` helper (`geometry/src/test_support.rs` exists), plus shared fixture strings.
- Effort: S

### PROC-AL-29: Two different composite-curve sampling paths feed the alignment
- Category: DRY | Severity: Low | Confidence: CONFIRMED
- Where: `rust/geometry/src/alignment.rs:405-416` (`from_sampled_curve` via `ProfileProcessor::get_curve_points`, which uses `curve_segment.rs`), and `rust/geometry/src/alignment_sampling_curve.rs:52-56`, which calls `sample_curve_segment` directly only to validate and then discards the result.
- What: each strict-sampled IFC4x3 segment is sampled twice (validate, then canonical), and per-segment points are recomputed.
- Fix: have the validator return or cache the samples, or validate inside the canonical walk via a strict flag.
- Effort: M

### PROC-AL-30: `AlignmentAxis::from_content` builds a full entity index per handle
- Category: Perf | Severity: Low | Confidence: CONFIRMED
- Where: `rust/geometry/src/alignment_sampling.rs:105-121`; caller `rust/wasm-bindings/src/alignment_axis.rs:17-21`.
- What: N alignment handles mean N full `build_entity_index` passes plus N `IFCPROJECT` scans.
- Fix: add a batch constructor that shares one decoder (as `sample_alignment_axes` already does), or a `from_decoder` exposed through wasm with a shared context.
- Effort: S

## Concept inventory

**Vector/matrix math**
- `AlignmentFrame` (origin/right/up/tangent) — `rust/geometry/src/alignment.rs:197`
- `AlignmentCurve::evaluate` frame construction — `alignment.rs:465`
- `compute_frame` (FixedAxisVertical, cant roll, IFC4x3 axis/refdir) — `rust/geometry/src/processors/sectioned.rs:310`
- `straight_y_frame` — `sectioned.rs:292`
- `is_proper` (handedness) — `sectioned.rs:401`
- `transform_outer` (2D→3D by frame) — `sectioned.rs:405`
- `compute_face_normal` — `sectioned.rs:586`
- `lerp_position` — `sectioned.rs:494`
- `lerp_direction` — `sectioned.rs:515`
- `interpolate_profile` — `sectioned.rs:458`
- Manual cross product — `rust/geometry/src/alignment_sampling_placement.rs:59-63`
- Manual column-major point/vector transform — `rust/geometry/src/alignment_sampling.rs:169-179`
- `LayerAxis::unit_vector` — `rust/geometry/src/material_layer_index.rs:41`

**Curve evaluation (alignment)**
- `h_eval` (line/arc/transition) — `alignment.rs:930`
- `v_eval` (line/parabola/circle-approximation) — `alignment.rs:1041`
- `TransitionKind::heading_integral` — `alignment.rs:102`
- `evaluate_vertical_frame` — `alignment.rs:513`
- `evaluate_horizontal` — `alignment.rs:558`
- `station_breaks` — `alignment.rs:312`
- `from_points` (point chain → segments) — `alignment.rs:420`
- `ArcLengthMap::new` / `horizontal_station` — `rust/geometry/src/alignment_arc_length.rs:18,43`
- `PositionAlongDirectrix::horizontal_station` — `rust/geometry/src/processors/sectioned_positions.rs:151`
- `subdivisions` (angle-budget subdivision) — `sectioned.rs:419`
- `locate_axis_curve` / `representation_axis_curve` — `rust/geometry/src/alignment_axis.rs:23,41`

**Transforms/placements**
- `validate_placement` (strict chain walk) — `rust/geometry/src/alignment_sampling_placement.rs:11`
- `validate_segment_placement` — `rust/geometry/src/alignment_sampling_curve.rs:80`
- `AlignmentAxis::evaluate` (placement apply + renormalise) — `alignment_sampling.rs:160`

**Tolerances/epsilons/limits**
- `alignment.rs`:
  - 1e-9 — `:327` (break dedup), `:525`, `:572`
  - 1e-12 — `:367`, `:431`, `:691`, `:722`, `:726`, `:1055`, `:1070`
  - transition integration `n∈[16,4096]`, 0.5/unit — `:997`
- `alignment_arc_length.rs:22` — `L/100_000` step, min 1.0
- `alignment_arc_length.rs:32,34` — 1e-12 speed clamp, 1e-6 ε
- `alignment_sampling.rs`:
  - `MAX_OUTPUT_SAMPLES=1_000_000` — `:13`
  - `MAX_DIAGNOSTICS=1_000` — `:14`
  - defaults 1.0 / 5_001 / 100_000 — `:27-29`
  - 1e-12 relative unit match — `:208`
- `alignment_sampling_curve.rs` — 100_000 work budget `:11`; 1e-12 `:110`, `:123`
- `alignment_sampling_placement.rs:64` — 1e-12 parallel axes
- `processors/alignment.rs`:
  - `SAMPLE_STEP_FILE_UNITS=1.0` — `:48`
  - `MAX_SAMPLES=5_000` — `:53`
  - `RIBBON_HALF_WIDTH_FILE_UNITS=0.25` — `:58`
- `processors/sectioned.rs`:
  - `MAX_ANGLE_STEP_RAD=0.0349` — `:76`
  - `MAX_SUBDIVISIONS=256` — `:80`
  - `PROBES=16` — `:435`
  - 1e-9 — `:333`, `:346`, `:427`
  - 1e-12 — `:373`, `:376`, `:517`, `:591`
- `processors/sectioned_positions.rs:171` — 1e-12
- `processors/curve_walk.rs` — `SEAM_EPS=1e-9` `:14`, `MAX_CURVE_NODES=100_000` `:17`
- `processors/texture/raster.rs:49` — `MAX_TEX_DIM=16384`
- `processors/texture/raster_header.rs:4` — `MAX_HEADER_BYTES=1 MiB`

**Unit conversion**
- `resolve_scale` (declared vs geometry LENGTHUNIT match) — `alignment_sampling.rs:198`
- `angle_scale = decoder.plane_angle_to_radians()` — `alignment.rs:269`
- `AlignmentAxis::length_m` (file units × scale) — `alignment_sampling.rs:157`

**Bbox/AABB:** none in the sub-area.

**Hashing:** none in the sub-area (FxHashMap containers only).

**Triangulation/polygon ops**
- `emit_cap` (earcut via `triangulate_polygon`) — `sectioned.rs:529`
- `emit_side_walls` — `sectioned.rs:558`
- Ribbon quad strip — `processors/alignment.rs:110-129`

**Entity attribute access/decoding**
- `read_bool(Option<&AttributeValue>)` — `alignment.rs:125`
- `read_bool(entity, idx)` — `processors/texture/mod.rs:189`
- `ifc_type_fn!` cached IfcType — `alignment.rs:40`
- `parse_horizontal` — `alignment.rs:594`
- `parse_vertical` — `alignment.rs:763`
- `from_polyline` — `alignment.rs:335`
- `PositionAlongDirectrix::parse` / `parse_distance_expression` — `sectioned_positions.rs:58,122`
- `read_direction` — `sectioned_positions.rs:162`
- `validate_primitive` — `alignment_sampling_curve.rs:133`
- `validate_vector` — `alignment_sampling_placement.rs:78`
- `validate_composite_with_budget` / `charge_references` — `alignment_sampling_curve.rs:14,71`
- `CurveWalk` / `spend` — `processors/curve_walk.rs:28,50`
- `decode_step_binary` / `hex_val` — `processors/texture/raster.rs:16,36`
- `raster_header::dimensions` — `processors/texture/raster_header.rs:6`
- `embedded_raster_dimensions` — `raster.rs:157`
- `decode_png` / `decode_jpeg` / `decode_raster_image` — `raster.rs:52,103,142`

**Relationship indexes**
- `MaterialLayerIndex::{from_content, from_spans, insert_association, to_flat, from_flat}` — `material_layer_index.rs:141,170,181,229,269`
- `resolve_buildup` / `resolve_layer_set_usage` — `material_layer_index.rs:369,393`
- `propagate_voids_via_aggregates` — `void_index.rs:35`
- `walk_aggregate_descendants` — `void_index.rs:70`
- `build_aggregate_children_index` — `void_index.rs:93`
- `propagate_voids_to_parts` — `void_index.rs:163`
- `compute_parts_to_skip` — `void_index.rs:225`
- `VoidIndex` (production-dead) — `void_index.rs:248`
- `build_texture_index` — `processors/texture/mod.rs:313`
- `resolve_triangle_texture_map` — `processors/texture/mod.rs:240`
- `resolve_surface_texture` (per-run cache) — `processors/texture/mod.rs:214`

**Colour/style resolution**
- `MeshTexture` / `TextureSource` / `ImageTextureRef` / `TextureAttachment` / `ResolvedTextureMap` — `processors/texture/mod.rs:34,49,60,72,79`
- `decode_blob_texture` / `decode_pixel_texture` / `read_image_texture` — `processors/texture/mod.rs:113,134,198`
- `LayerInfo.material_id` (per-layer colour key) — `material_layer_index.rs:56`

**Error types**
- `crate::Error::geometry(String)` everywhere (the alignment and sectioned code).
- `Option`-only failures in texture, `gradient.rs` and `curve_segment.rs`; errors swallowed silently (PROC-AL-23/26).
- `AlignmentSamplingDiagnostic{,Code}` (bounded diagnostic buffer) — `alignment_sampling.rs:57,64`
- `crate::diag::diag_warn!` used once — `alignment.rs:887`