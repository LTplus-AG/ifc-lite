I found 24 issues in the LandXML geometry/math code. One is High, 10 are Medium and 13 are Low. Nothing was run; every finding comes from reading the code, and I re-checked each cited line.

**What came back clean:**
- **f32:** no f32 casts anywhere in `rust/landxml/src`. The LandXML bindings pass f64 through; the f32 conversion happens in TS, which was out of scope.
- **Angles:** LandXML `angularUnit`/`directionUnit` are never parsed. All horizontal geometry comes from coordinates, and both crates use the math angle (atan2(N, E), counter-clockwise from east). There are no bearing, azimuth or grads conversions to drift.
- **Determinism:** no HashMap iteration reaches output in scope. Plan references use HashMap for lookups only, and terrain dedupe uses BTreeMap.
- **Panics, overflow, NaN:** none found that are reachable. Parcel and terrain budgets use checked arithmetic, `scaled_ratio` is overflow-safe, and the point-in-polygon divisors are guarded by the crossing test.
- **Rust bindings:** they reuse the native probe and validators, apart from the copies listed in EDGE-3 and EDGE-13.

### EDGE-1: Circular-arc validation exists twice in the crate, and the parcel copy's tolerances refuse realistic curved parcels
- Category: DRY
- Severity: High
- Confidence: LIKELY
- Where:
  - `rust/landxml/src/alignment/numeric/geometry.rs:143-182` (`curve_geometry`) and `:315-322` (`sweep`)
  - `rust/landxml/src/plan/numeric/measure.rs:7-32` (`arc_delta`)
  - `rust/landxml/src/plan/numeric/parcel_measure.rs:118-150` and `:161-184` (`curve_edges`)
- What: the same check ("centre-to-endpoint distance equals radius, the sweep follows `rot`, the declared length matches") is written twice and has drifted:
  - **Radius:** the alignment copy allows `(start_radius - radius).abs() > radius * 1e-7`, a relative tolerance. The parcel copy uses `(distance(center, start)? - radius).abs() > EPSILON`, an absolute 1e-9.
  - **Length:** the alignment copy allows 1e-6 relative (`geometry_tolerance`). The parcel copy allows `EPSILON * radius.max(length).max(1.0)`, which is 1e-9 relative.
  - **Coincident endpoints:** the alignment copy treats them as a full circle (`rotation.sign() * TAU`, geometry.rs:168-169). The parcel copy returns `None` (measure.rs:22).
  - **Rotation:** the alignment copy uses the `LandXmlRotation` enum; the parcel copy matches raw `Option<&str>` "cw"/"ccw".
  - Arc point sampling (`center + r·(cos, sin)`) is repeated at geometry.rs:132-136 and parcel_measure.rs:174-179.
  - The parcel fixtures in `tests/plan.rs` only use unit or integer radii, so the strict tolerance is never exercised.
- Why it matters:
  - Producer coordinates are rounded to 4-8 decimals, and at georeferenced magnitude (~1e6) f64 differences alone are around 1e-10 to 1e-9. So a real arc-plus-chord parcel fails the 1e-9 absolute check.
  - It then lands as preserved-only with the misleading reason "open or unresolved boundary" (parcel_probe.rs:231-233).
  - The same arc is accepted in an alignment and refused in a parcel.
- Fix: one `fn circular_arc(start, center, end, rot: LandXmlRotation, radius: Option<f64>, declared_len: Option<f64>) -> Result<ArcGeom>` in a shared `landxml::numeric::arc` module, with one relative-tolerance policy, one full-circle policy and one `sample(n)`. Parse plan `rot` into `LandXmlRotation`.
- Effort: M

### EDGE-2: Clothoid / spiral integration is implemented three ways with different accuracy and domain rules
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/landxml/src/alignment/numeric/geometry/clothoid.rs:39` (`integral`)
  - `rust/geometry/src/alignment.rs:968-1019` (transition branch of `h_eval`; `n` at :997)
  - `rust/geometry/src/curve_segment.rs:64-81` (`clothoid_point` / `clothoid_interval`)
- What:
  - LandXML uses a single-panel 16-point Gauss-Legendre rule with a general κ0→κ1 blend, and refuses anything with `|κ·L| > 2` (clothoid.rs:10-17).
  - geometry `alignment.rs` uses a composite trapezoid with `n = ceil(s/2).max(16).min(4096)`. That is about a 2 m step and O(h²) error, roughly mm to cm on tight spirals.
  - `curve_segment.rs` uses composite Simpson with a 0.25 m step, `n.clamp(2, 20_000)`, for κ0 = 0 only.
  - Unsupported transition types also drift: `alignment.rs:95` maps unknown types to `_ => Self::Clothoid`, while LandXML refuses any `spiType != "clothoid"` (clothoid.rs:21).
- Why it matters: the same spiral evaluates to different coordinates depending on the source format. The geometry paths approximate silently where LandXML refuses.
- Fix: a `pub fn clothoid_integral(k0, k1, length, s) -> (f64, f64)` in `ifc_lite_geometry` (landxml already depends on it), using composite Gauss-Legendre with an explicit error bound. All three sites call it.
- Effort: M

### EDGE-3: The plan point-resolver adapter is copied into the WASM binding, and the copies use different work budgets
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Work limit: `rust/landxml/src/stream/derived/plan.rs:242-269` vs `rust/wasm-bindings/src/api/landxml/endpoints.rs:237-263`
  - Geometry resolution: `stream/derived/plan.rs:271-296` vs `endpoints.rs:198-230`
  - Monument resolution: `stream/derived/plan.rs:134-146` vs `endpoints.rs:294-303`
- What:
  - The binding builds one `LandXmlPlanResolver` for the whole document (endpoints.rs:264), so the budget and alias cache are shared.
  - The stream builds a fresh resolver per record (plan.rs:114-115, :137, :275). Each one gets the full document budget and an empty cache.
  - It also recomputes the O(features + parcels) work limit for every record.
- Why it matters:
  - The two load paths can disagree: a document can hit LimitExceeded in `parseLandXmlSourceBytes` and succeed in the stream.
  - Total stream work is O(n²) and gets no benefit from the resolver's cache.
- Fix: `LandXmlPlanDocument::resolution_work_limit()`, `resolve_geometry(&mut resolver, &geom)` and `resolve_monument(&mut resolver, &m)` in `plan/numeric/references.rs`. `PlanDerivedCursor` should own one resolver for its whole lifetime.
- Effort: S

### EDGE-4: Alignment display sampling is duplicated, the copies truncate differently, and the stream summary computes it twice
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/landxml/src/alignment/render_data.rs:9-11, 31-71`
  - `rust/landxml/src/stream/derived/alignment.rs:10-12, 43-85`
  - `rust/landxml/src/stream/metadata/reassembly.rs:188`
- What:
  - Both copies define `POINTS_PER_SPAN = 65`, `MAX_POINTS = 250_000` and `MAX_REFUSALS = 1_024`.
  - When a span would pass `MAX_POINTS`, `render_data` returns immediately (:47-52). The stream cursor `continue`s (:58-61), so it keeps evaluating every remaining segment and can emit refusals that the non-stream path never produces.
  - The reassembler ignores the streamed span records (reassembly.rs:146-148) and recomputes them with the other algorithm.
- Why it matters: streamed events and the reassembled `LandXmlStreamMetadata.alignment_render` can disagree. All sampling is also done twice.
- Fix: one `AlignmentRenderSampler` iterator in `alignment/render_data.rs` that holds the constants and the budget. `alignment_render_data` collects it; the stream cursor wraps it.
- Effort: S

### EDGE-5: The 2D predicates in LandXML terrain and parcel code are copies of geometry's `geom2d`, and the parcel copy is inexact
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/landxml/src/terrain_topology.rs:143-176` (`orient` / `on_segment` / `edges_touch`) duplicates `rust/geometry/src/geom2d.rs:85-115` (`orientation` / `on_segment` / `segments_intersect`) line for line.
  - `rust/landxml/src/terrain_validation.rs:16-22` (`point_on_segment`) is also `geom2d::on_segment`.
  - Point-in-ring: `rust/landxml/src/terrain_topology.rs:260-280`, `rust/landxml/src/plan/numeric/topology.rs:131-149`, `rust/geometry/src/geom2d.rs:52-67` and `rust/geometry/src/triangulation/ring_geom.rs:23`.
  - Inexact variant: `rust/landxml/src/plan/numeric/topology.rs:40-76, 95-126`.
- What: `geom2d` is `pub(crate)`, so LandXML copied it. The terrain copies use exact `orient2d`. The parcel copy uses raw float cross products with an absolute `EPSILON` of 1e-9 (topology.rs:72-75, 114, 122-125).
- Why it matters: terrain and parcel topology use different robustness rules for the same contact question. The parcel threshold is scale-dependent.
- Fix: make `geom2d::{orientation, on_segment, segments_intersect, point_in_polygon}` `pub` from `ifc_lite_geometry` and use them in all five places. Keep the parcel adjacency logic as a thin wrapper over exact predicates.
- Effort: S

### EDGE-6: Terrain constraints are scanned twice, once in LandXML and again in geometry's CDT
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/landxml/src/terrain_topology.rs:180-220` (`validate_simple_ring`, O(n²))
  - `rust/landxml/src/terrain_validation.rs:100-130` (`validate_split_elevations`, O(segments·vertices))
  - `rust/geometry/src/terrain_cdt.rs:96-145` (`validate_original_segments`, O(S²)) and `:147-178` (`split_segments_at_vertices`, O(S·V))
  - Duplicate-key normalisation: `terrain_topology.rs:44-50` (`bits`) vs `terrain_cdt.rs:70`
- What: LandXML finds collinear on-segment vertices to check their elevations, and the CDT then repeats the identical scan to split the segments. Pairwise ring checks are repeated in the same way.
- Why it matters: the dominant quadratic terrain cost is paid twice, and both copies are charged against `max_work`.
- Fix: have `terrain_cdt` expose `split_segments_at_vertices` and return the split points with their fractions, so LandXML checks elevations on that result. Or pass an elevation-check callback into `triangulate_terrain_pslg_with_progress`.
- Effort: M

### EDGE-7: Vertical circular and parabolic curves are evaluated five ways; IFC4x1 circular arcs use a parabolic approximation
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Circular:
    - `rust/landxml/src/profile_circular.rs:18-110, 184-233` (exact, overflow-safe)
    - `rust/geometry/src/gradient.rs:180-185` (`circular_from_radius`) and `:196-206` (`circular`)
    - `rust/geometry/src/alignment.rs:1060-1074` (`VSeg::CircularArc`)
  - Parabolic:
    - `rust/landxml/src/profile_evaluator.rs:208-230` and `:232-270`
    - `rust/geometry/src/gradient.rs:187-190`
    - `rust/geometry/src/alignment.rs:1044-1059`
- What:
  - `alignment.rs:1068` comments "Parabolic approximation accurate to ~mm ... (R > 500 m)", while an exact evaluator already exists in the same crate (`gradient.rs:180`). At R = 100 m and s = 50 m it is about 0.9 m off (13.4 m exact vs 12.5 m).
  - `gradient.rs` clamps the sine to [-1, 1] (`:182`, `:203`), which silently hides inconsistent inputs. LandXML refuses them instead.
  - Zero radius or constant is handled three ways: landxml rejects ≤ 0, `alignment.rs` uses `.max(1e-12)`, and `gradient.rs:199` falls back to a straight line below 1e-12.
- Why it matters: vertical geometry for the same curve depends on which crate and which IFC version evaluates it. The IFC4x1 path is materially wrong for small radii.
- Fix: a `pub mod vertical_curve` in `ifc_lite_geometry` with `parabolic(h0, g0, g1, len, u)` and an exact `circular(h0, g0, signed_r, u) -> Result`. Use it from `alignment.rs` `v_eval` and `gradient.rs`. LandXML can keep its overflow-safe front end and delegate the core evaluation.
- Effort: M

### EDGE-8: Profile evaluation resolves each curve's PVIs twice and finds them by float equality
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: `rust/landxml/src/profile_evaluator.rs:21-63` vs `:106-152` (the jscpd hits 33-45 / 118-130 and 52-64 / 141-153)
- What:
  - `evaluate_elevation_at` calls `validate_curve_declarations`, and both run the same `position(|pvi| pvi.station == curve.station && pvi.elevation == curve.elevation)` lookup, the triple `get().zip()` and the grade computation.
  - That is O(curves × PVIs), twice, on every call. `evaluate_circular` also builds `circular_geometry` twice (:281 and via `circular_bounds` :303).
  - The parser already knows the curve's PVI index (`parser/profiles/finish.rs:36-56`) but throws it away.
- Why it matters: sampling N stations costs O(N·C·P). Two PVIs with identical station and elevation bind to the first one. There are no production callers yet, so this is latent.
- Fix: store `pvi_index` on `LandXmlVerticalCurve` (or build a `ResolvedProfile { curves: Vec<ResolvedCurve{start, end, g_in, g_out, kind}> }` once). Evaluate with `partition_point`.
- Effort: S

### EDGE-9: `IrregularLine` probes fail at the segment end when the declared length exceeds the polyline length
- Category: Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/landxml/src/alignment/numeric/geometry.rs:105-124` (`evaluate_irregular`) and `:196-211` (`irregular_length`)
  - `rust/landxml/src/alignment/numeric/station.rs:185-188`
- What:
  - `segment_length` returns the declared length when it is within `geometry_tolerance` (up to 1e-6·L) of the geometric one.
  - `segment_at_distance` clamps the local distance to that declared length.
  - `evaluate_irregular` then walks the geometric pairs with only `+ EPSILON` (1e-9) of slack and falls through to `Err("LXMLA208", "irregular line has no non-zero geometry")`.
  - The only test (`tests/alignment_numeric.rs:211`) uses `declared_length: None`.
- Why it matters: probes and station lookups near or at the end of any irregular line whose declared length is a little over the polyline length fail with a misleading error.
- Fix: map declared distance onto geometric distance proportionally, as `evaluate_curve` does (`distance * geometric / declared`), or clamp `remaining` on the last pair.
- Effort: S

### EDGE-10: The circular vertical-curve length check allows only 32 ULP, far stricter than every other length check
- Category: Quirk
- Severity: Medium
- Confidence: LIKELY
- Where:
  - `rust/landxml/src/profile_circular.rs:83-89`
  - Compare `rust/landxml/src/alignment/numeric/geometry.rs:247-249`, `numeric.rs:234-236`, `clothoid.rs:27`
- What: the check is `tolerance = 32.0 * ulp(length).max(ulp(expected_length))`, about 7e-15 relative. Declared-versus-computed length checks elsewhere allow `(length * 1e-6).max(1e-6)`. The fixtures (`tests/ingest.rs:2029, 2064, 2154`) build radii with 12-17 significant digits.
- Why it matters:
  - A producer `CircCurve length="…" radius="…"` rounded to a few decimals is always rejected with `InconsistentCircularCurve`.
  - The comment's reason ("already represented f64 source quantities") does not hold for rounded text input.
- Fix: share one `declared_length_tolerance(len)` across alignment and profile, or document why profiles intentionally need exact producer arithmetic.
- Effort: S

### EDGE-11: The comment on assumed units contradicts the declared-unit behaviour, and the two paths scale elevations differently
- Category: Quirk
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/landxml/src/semantics.rs:84-90` (comment) and `:91-99` (`assumed_units`)
  - `rust/landxml/src/semantics.rs:57-59`
  - `rust/landxml/src/pipe_parser/convert.rs:14-20`
- What:
  - The comment says the assumed linear unit applies to elevation too, "matching how a `<Units>` element with no `elevationUnit` behaves". But a declared `<Units>` with no `elevationUnit` defaults elevation to `"meter"` (semantics.rs:59), as the pipe parser comment also says (LandXML 1.2 default).
  - So `assumedLinearUnit="foot"` scales elevations by 0.3048, while `<Imperial linearUnit="foot"/>` scales them by 1.0.
  - The exporter writes US-survey files with `elevationUnit="feet"`, i.e. the international foot (`rust/export/src/landxml_terrain.rs:57-63`). That contradicts the assumed path's survey-foot elevation.
- Why it matters: the stated reason is out of date, and the assumed path is the inverse of the default it claims to copy.
- Fix: decide the policy explicitly (follow the meter default, or add an `assumedElevationUnit`), then rewrite the comment. This is part of the open LandXML georef-assumptions goal.
- Effort: S

### EDGE-12: The LandXML linear-unit table is duplicated, and the copies handle a blank `elevationUnit` differently
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/landxml/src/semantics.rs:70-81` vs `rust/landxml/src/pipe_parser/convert.rs:386-397`
  - Related tables: `rust/landxml/src/plan/parser/value.rs:7-17` (area), `rust/export/src/landxml_terrain.rs:48-63`, `rust/core/src/unit_labels.rs:67-76`
- What:
  - The two LandXML tables are identical today (`USSurveyFoot => 1200.0 / 3937.0`), with different error types.
  - `semantics` treats a blank `elevationUnit` as meter (`.filter(|u| !u.trim().is_empty())`). The pipe parser passes `""` to `scale` and refuses it. The same document can be accepted by one parser and refused by the other.
  - Core uses `US_SURVEY_FOOT_SCALE = 0.3048006096` (unit_labels.rs:76), a truncated decimal (true value 0.30480060960121924…). It is commented as "1200/3937", and `core/src/georef.rs:525-526` claims exact ratios. The difference is only about 4e-12 relative, but the claim is false.
- Why it matters: the copies will drift on the next unit added, and the blank-unit difference is a parity bug between parsers.
- Fix: one `pub(crate) fn landxml_linear_scale(&str) -> Option<f64>` plus a shared units parser used by both `semantics` and `pipe_parser`. Set core's constant to `1200.0 / 3937.0`.
- Effort: S

### EDGE-13: The WASM probe/inspect endpoints repeat parse-and-find three times and re-implement the superelevation filter
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/wasm-bindings/src/api/landxml/endpoints/methods.rs:129-135, 159-165, 192-198` (parse plus find-by-id)
  - `methods.rs:202-212` vs `rust/landxml/src/alignment/inspection.rs:69-85`
- What:
  - Every probe call re-parses the whole LandXML byte buffer with `parse_landxml_alignments_optional(data)`.
  - The inspect endpoint recomputes `internal_station = sta_start + distance` and the inclusive range filter inline instead of calling `superelevations_at_distance`.
- Why it matters: per-hover probing costs O(file size), and the copied filter can drift.
- Fix: a `fn find_alignment(data, id) -> Result<…>` helper in the binding (or a cached-document handle). Call `superelevations_at_distance` and truncate after it.
- Effort: S

### EDGE-14: Station-equation walking and validation are written three times
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/landxml/src/alignment/numeric.rs:119-169` (`station_mapping`, which re-checks ordering at :128-138)
  - `rust/landxml/src/alignment/numeric.rs:170-214` (`validate_station_equations`, :174-187)
  - `rust/landxml/src/alignment/numeric/station.rs:48-83` (`distances_for_station_validated`)
- What: the `previous / displayed / direction` fold and the `index == 0 ? < - EPS : <= + EPS` ordering check are repeated. `station_mapping` re-validates on every call even after `validate_numeric_alignment` has run.
- Why it matters: the forward and inverse mappings must stay exact inverses, and three copies make that fragile.
- Fix: precompute a `Vec<StationRange{internal_start, internal_end, display_start, direction}>` once. Forward lookup uses `partition_point`; inverse lookup is a scan over that table.
- Effort: S

### EDGE-15: Small 2D and validation helpers are copied inside the alignment numeric module and the plan code
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - Distance: `numeric.rs:228` (`planar_distance`), `numeric/geometry.rs:312` (`distance_between`), `geometry/clothoid.rs:42` (`distance_between`), `plan/numeric/measure.rs:34, 38`
  - `geometry_tolerance`: `numeric.rs:234`, `numeric/geometry.rs:247`, inline at `clothoid.rs:27`
  - `valid_length`: `numeric/geometry.rs:324`, `clothoid.rs:38`
  - Coordinate/finite checks: `numeric/geometry.rs:250, 263`, `clothoid.rs:36`, `measure.rs:56`
  - Checked add: `numeric.rs:215` (`finite_add`), `measure.rs:62` (`finite_sum`)
  - `EPSILON = 1e-9` declared 3 times: `numeric.rs:16`, `plan/numeric.rs:18`, `parcel_measure.rs:11`
- What: identical bodies; the clothoid copies exist only because the file is in a separate module.
- Why it matters: tolerance changes have to be made in several places.
- Fix: one `landxml::numeric::{EPSILON, distance, tolerance, finite_point, finite_add}` module.
- Effort: S

### EDGE-16: Two pairs of model types share a name
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `LandXmlPlanPoint` at `rust/landxml/src/alignment/model.rs:14` and `rust/landxml/src/plan/model.rs:18` (identical fields)
  - `LandXmlAlignment` at `rust/landxml/src/profile.rs:17` (summary record) and `rust/landxml/src/alignment/model.rs:69` (full record)
- What: `crate::LandXmlPlanPoint` and `crate::alignment::LandXmlPlanPoint` are distinct identical types, so alignment and plan helpers cannot be shared.
- Why it matters: this is the structural blocker for EDGE-1 and EDGE-15. The `LandXmlAlignment` name clash also confuses API users (the TS side already calls one `LandXmlAlignmentSummaryJs`).
- Fix: one `LandXmlPlanPoint` re-exported by both modules. Rename the profile one to `LandXmlAlignmentSummary`.
- Effort: M (public Rust API change)

### EDGE-17: Station-to-segment lookup is reimplemented with different boundary ownership
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/landxml/src/alignment/numeric/station.rs:182-197` (linear; a boundary belongs to the later segment)
  - `rust/landxml/src/profile_evaluator.rs:318-347` (linear windows; the earlier pair)
  - `rust/landxml/src/alignment/inspection.rs:52-54` (binary search)
  - `rust/geometry/src/alignment.rs:571-573` (binary search; earlier segment)
  - `rust/geometry/src/alignment.rs:513-556` (linear)
  - `rust/geometry/src/gradient.rs:92` (binary search; later segment)
  - `rust/geometry/src/alignment_arc_length.rs:51` (binary search)
- What: there are linear and binary-search variants, and the exact-boundary convention flips between them.
- Why it matters: at a G1-only joint the reported tangent or curvature depends on which crate is asked.
- Fix: one `fn locate(cum_ends: &[f64], s) -> (idx, local)` with a documented convention, in geometry, used by both crates.
- Effort: S

### EDGE-18: Plan source-ID traversal and batch size are duplicated
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `rust/landxml/src/plan/numeric.rs:52-99` (`source_batches`) vs `rust/landxml/src/stream/derived/plan.rs:168-210` (`next_source_id`)
  - Batch size: `plan.rs:13` (`SOURCE_BATCH_SIZE = 128`) vs the literal `128` at `rust/wasm-bindings/src/api/landxml/endpoints.rs:278`
- What: the same cogo → monument → feature+geometry → parcel+loops order is written once as an eager chain and once as a resumable cursor.
- Why it matters: if either order changes, stream and non-stream batches diverge.
- Fix: one resumable iterator, with `source_batches` collecting it; export the constant.
- Effort: S

### EDGE-19: Test fixture and terrain error plumbing are duplicated
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - Fixture: `rust/landxml/tests/units_required_5175.rs:24-45` vs `rust/wasm-bindings/src/api/landxml_stream.rs:206-223`
  - Error enums: `rust/landxml/src/terrain_topology.rs:32-35` (`TopologyValidationError`) and `rust/landxml/src/terrain_validation.rs:11-14` (`SplitElevationValidationError`) have identical shapes
  - `diagnostic()`: `rust/landxml/src/terrain.rs:22` and `rust/landxml/src/terrain_topology.rs:37-42`
- What: copy-paste.
- Fix: a shared `TerrainStepError` with a `From<TerrainCdtError>` conversion. Put the fixture in a `testdata` constant.
- Effort: S

### EDGE-20: Every probe re-validates the whole alignment and searches segments linearly
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/landxml/src/alignment/numeric/station.rs:14, 32, 93, 142, 175, 182-197`
  - `rust/landxml/src/alignment/numeric/geometry/clothoid.rs:20-34`
  - `rust/landxml/src/alignment/numeric/render.rs:44-47`
- What:
  - Each public call runs `validate_numeric_alignment` over all n segments; each clothoid costs 3 quadratures plus PI checks.
  - `segment_at_distance` then calls `validate_segment` again per segment, and `clothoid::evaluate` re-validates the domain, endpoint and PI every time.
  - `probes_at_station` repeats this for up to 128 matches.
  - `render_span` pays a full clothoid validation per sample, i.e. 65 × 3 quadratures per spiral.
- Why it matters: probing is O(n) with a heavy constant, sampling is O(n·m), and the WASM layer adds a full re-parse per call (EDGE-13).
- Fix: a validated `PreparedAlignment { cum_ends, prepared_segments (with cached heading/curvature/geometry) }` built once and searched with `partition_point`.
- Effort: M

### EDGE-21: Faceless-TIN adaptation clones whole surface collections
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/landxml/src/terrain.rs:38, 55, 77, 105` (`surface.points.clone()`, `source_data_points.clone()`, `boundaries.clone()`, `breaklines.clone()`) and `:89-90` (`ring.clone()`, moved immediately after)
- What: each vector is fully deep-copied, strings included, only to get around borrowing `surface` mutably in `add_vertex` and `line_vertices`.
- Why it matters: O(points) of extra allocation on the largest inputs.
- Fix: `std::mem::take` and restore, iterate by index, or split `SurfaceBuilder` so the mutable borrow is narrower. Push `ring` without cloning.
- Effort: S

### EDGE-22: `adapt_faceless_tin` is a 376-line function with the same error-mapping match repeated eight times
- Category: Maintainability
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - `rust/landxml/src/terrain.rs:25-400`
  - Repeated `TerrainCdtError → Ok(Some(WorkLimitExceeded)) / Err(Cancelled) / unreachable!` blocks at 197-211, 216-231, 243-258, 263-278, 282-297, 313-324, 328-343, 352-365
- What: other long functions in scope:
  - `probe_parcel_with_work`: 111 lines (`plan/numeric/parcel_probe.rs:201-311`)
  - `circular_geometry`: 93 (`profile_circular.rs:18-110`)
  - `evaluate_elevation_at`: 87 (`profile_evaluator.rs:13-99`)
  - `geometry_measure`: 81 (`plan/numeric/parcel_measure.rs:77-157`)
  - `next_record_with`: 80 (`stream/derived/plan.rs:87-166`)
- Why it matters: the same match logic is copied eight times, and the `unreachable!` arms would abort WASM (panic = abort) if `TerrainCdtError` gains a variant.
- Fix: one `fn outcome(e: TerrainCdtError) -> Result<Option<LandXmlTerrainDiagnostic>, LandXmlError>` plus `?`, and split the function into collect, constraints, validate, triangulate and filter steps.
- Effort: M

### EDGE-23: `clothoid.rs` is hand-minified onto very long lines
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: `rust/landxml/src/alignment/numeric/geometry/clothoid.rs:20-41`; line 39 is 1011 characters, line 36 is 588
- What: whole functions, including the Gauss-Legendre node and weight tables, sit on single lines. `integral` reports errors against a made-up source ID, `LandXmlSourceId("landxml:spiral")` (:39).
- Why it matters: it can't be reviewed or diffed sensibly, and line-count tooling is effectively bypassed.
- Fix: rustfmt this file only (consistent with the "no blanket fmt" rule) and pass the real source ID through.
- Effort: S

### EDGE-24: Error types, codes and tolerance policies are inconsistent across the numeric surfaces
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - Alignment: `LandXmlNumericDiagnostic{source_id, code: &'static str}` (`alignment/numeric.rs:21`)
  - Profile: `LandXmlProfileEvaluationError` with no source ID (`profile.rs:84`)
  - Parcel: `LandXmlError` plus free-text `PreservedOnly{reason}` (`parcel_probe.rs:331`)
  - Terrain: `LandXmlTerrainDiagnostic` plus two progress enums
  - Pipes: `Result<_, String>` (`pipe_parser/convert.rs:12, 386`)
  - Code reuse: `LXMLA207` covers both station-equation and Cant ordering (`numeric.rs:135`, `inspection.rs:47`); `LXMLA230` covers two different conditions (`station.rs:74, 171`)
  - Tolerances drift: continuity is scaled by cumulative chainage (`numeric.rs:77`, allowing a 5 cm gap on a 50 km alignment); curve radius uses 1e-7·R (`geometry.rs:155-156`) while length uses 1e-6·L; line and irregular segments are parameterised by geometric length but curves and spirals by declared length (`geometry.rs:291` vs `:131`)
- Why it matters: callers can't handle refusals uniformly, and the tolerance scale has no single justification.
- Fix: one `NumericDiagnostic { source_id, code: enum, message }` across alignment, profile and parcel, and a single tolerance module (see EDGE-15).
- Effort: M

---

## Concept inventory

**Vector/2D math**
- Distance:
  - `alignment/numeric.rs:228` `planar_distance`
  - `alignment/numeric/geometry.rs:312` `distance_between`
  - `alignment/numeric/geometry/clothoid.rs:42` `distance_between`
  - `plan/numeric/measure.rs:34` `same_point`, `:38` `distance`
- Normalize and interpolate: `alignment/numeric/geometry.rs:301` `normalize`, `:277` `interpolate`
- Local frame transforms: `geometry/clothoid.rs:40` `transform_local`, `:41` `tangent_line_distance`
- Cross/orientation:
  - `plan/numeric/measure.rs:45` `cross`
  - `plan/numeric/topology.rs:55` (orientation closure), `:112` (cross/dot)
  - `terrain_topology.rs:143` `orient` (exact)
  - Geometry crate: `geom2d.rs:85` `orientation`
- Arc angles:
  - `alignment/numeric/geometry.rs:315` `sweep`
  - `plan/numeric/measure.rs:7` `arc_delta`
  - Geometry crate: `alignment.rs:938-967`, `curve_segment.rs:46-49`
- Clothoid:
  - `geometry/clothoid.rs:39` `integral`
  - Geometry crate: `alignment.rs:968-1019`, `curve_segment.rs:64-81`, `alignment.rs:102` `heading_integral`
- Vertical curves:
  - `profile_evaluator.rs:208, 232, 272, 318`
  - `profile_circular.rs:18` `circular_geometry`, `:184` `circular_rise`, `:122` `scaled_ratio`, `:112` `ulp`
  - Geometry crate: `gradient.rs:180, 187, 196`, `alignment.rs:1041` `v_eval`
- Matrix math: none in landxml.

**Transforms / georef**
- `alignment/numeric/station.rs:129-130` (right-offset normal)
- CRS kept as raw strings: `model.rs:319` `LandXmlCoordinateSystem`
- No RTC or f32 anywhere in landxml.

**Tolerances / epsilons**
- `EPSILON = 1e-9`: `alignment/numeric.rs:16`, `plan/numeric.rs:18`, `plan/numeric/parcel_measure.rs:11`
- `alignment/numeric.rs:235` (`length*1e-6` max `1e-6`) and `:238` (`1e-12` relative plus EPSILON)
- `alignment/numeric/geometry.rs`: `:155-156` (`radius*1e-7`), `:248` (`1e-6`); EPSILON used at `:114, 154, 168, 221, 226, 234, 241, 303, 325`
- `geometry/clothoid.rs:14` (`|κL| > 2.0`), `:27` (`1e-6`); EPSILON at `:37, 38, 39`
- `alignment/numeric/station.rs:15, 64, 68, 109, 187` (EPSILON)
- `alignment/numeric.rs:103, 130-131, 139, 148, 178-180` (EPSILON)
- `plan/numeric/measure.rs:22, 26, 35`
- `plan/numeric/parcel_measure.rs:121, 123-124`, `:169` (`MAX_SEGMENTS = 64`)
- `plan/numeric/topology.rs:72-75, 114, 122-125`
- `profile_circular.rs:83` (`32·ulp`), `:196` (`-1.0e-12`)
- `terrain_validation.rs:30, 40` (`8·f64::EPSILON·scale`)
- `pipe_parser/inverts.rs:155` (`1e-9`)
- `parcel_probe.rs:15-16` (700 edges / 1e6 work)
- `render_data.rs:9-11` and `stream/derived/alignment.rs:10-12` (65 / 250 000 / 1 024)
- Geometry-crate comparisons:
  - `alignment.rs:327, 367, 431, 525, 572, 691, 722, 726, 997, 1055, 1070`
  - `gradient.rs:78, 97, 117, 150, 176, 199`
  - `curve_segment.rs:27` (`MAX_STEP 1.0`), `:30`, `:71` (`0.25`), `:89, 94`
  - `alignment_arc_length.rs:32, 34`
  - `geom2d.rs:22` (`PARALLEL_EPS`)

**Unit conversion**
- `semantics.rs:55` `units`, `:70` `scale`, `:91` `assumed_units`, `:106` `resolve_assumed_units`
- `pipe_parser/convert.rs:12` `units`, `:386` `scale`, `:337` `measure`
- `plan/parser/value.rs:7` `area_scale`
- Parcel scaling: `plan/numeric/parcel_probe.rs:271-301`
- Comparisons: `core/src/unit_labels.rs:58` `get_conversion_based_unit_factor`, `:76` `US_SURVEY_FOOT_SCALE`; `export/src/landxml_terrain.rs:48-63`

**Bbox**
- None in landxml (bounding-box tests are inline in `on_segment` copies).
- Comparisons: `geometry/src/geom_bounds.rs`.

**Hashing / keys**
- `terrain_topology.rs:44` `bits` (normalises -0) feeding the `BTreeMap<(u64,u64)>` at `:54`
- Comparisons: `geometry/src/terrain_cdt.rs:70` (`FxHashSet`), `plan/model.rs:56-59` (reference index HashMaps, lookup only), `plan/numeric/references.rs:19` (resolver cache)

**Triangulation / polygon ops**
- `terrain.rs:25` `adapt_faceless_tin`
- `terrain_topology.rs:52` `add_vertex`, `:103` `line_vertices`, `:180` `validate_simple_ring`, `:222` `ring_edges`, `:260` `point_in_ring`
- `terrain_filter.rs:10` `point_is_in_permitted_region`
- `terrain_validation.rs:16, 47, 59, 100`
- `plan/numeric/topology.rs:7` `segments_intersect`, `:40` `intersects`, `:95` `overlaps_beyond_shared_endpoint`, `:117` `on_segment`, `:131` `point_in_loop`
- `plan/numeric/parcel_measure.rs:21` `probe_loop` (shoelace about the first vertex), `:161` `curve_edges`
- Comparisons: `geometry/src/terrain_cdt.rs:52, 96, 147`; `geometry/src/geom2d.rs:52, 97, 105`; `geometry/src/triangulation/ring_geom.rs:23`

**Error types**
- `alignment/numeric.rs:21` `LandXmlNumericDiagnostic` and `:247` `diagnostic`
- `profile.rs:84` `LandXmlProfileEvaluationError`
- `model.rs` `LandXmlError` / `LandXmlTerrainDiagnostic`
- `terrain_topology.rs:32` `TopologyValidationError`
- `terrain_validation.rs:11` `SplitElevationValidationError`
- `plan/numeric/measure.rs:66` `finite_measure` (`LandXmlError`)
- `pipe_parser/convert.rs` (`String`)
- WASM: `JsValue::from_str` strings (`endpoints/methods.rs`)