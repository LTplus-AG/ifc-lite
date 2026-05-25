# @ifc-lite/wasm

## 1.19.0

### Minor Changes

- [#659](https://github.com/LTplus-AG/ifc-lite/pull/659) [`f209e34`](https://github.com/LTplus-AG/ifc-lite/commit/f209e342c306041ea045bc108595676efa671eec) Thanks [@louistrue](https://github.com/louistrue)! - Render IfcAnnotation 2D representations as a 3D drawing-layer overlay
  (closes [#653](https://github.com/LTplus-AG/ifc-lite/issues/653)). Implements the BIMVision-style "model + annotations =
  engineering drawing" effect described by the OP.

  What's covered:

  - **Rust WASM**: new `SymbolicText` and `SymbolicFillArea` types
    carried alongside the existing symbolic polyline output. The parser
    walks `IfcTextLiteralWithExtent.Placement` and
    `IfcAnnotationFillArea.OuterBoundary`/`InnerBoundaries` (across
    `IfcPolyline` and `IfcIndexedPolyCurve`).
  - **TS hook**: `useSymbolicAnnotationsRichData()` returns 3D-lifted
    texts + fills with per-storey resolution. Module-level parse cache
    is now keyed on `byteLength + FNV-1a fingerprints of head/mid/tail`,
    so federated views with same-size IFCs no longer alias each other.
    Storey elevation handling distinguishes "no authored elevation"
    from "elevation = 0.0" (the previous sentinel collapsed both to
    the fallback Y).
  - **Renderer**: two new WebGPU pipelines — `SymbolicFillPipeline`
    (ear-clipping triangulation with rightmost-vertex bridge-edge
    hole stitching, premultiplied-alpha blend) and
    `SymbolicTextPipeline` (Canvas2D glyph atlas → instanced WebGPU
    quads). Both declare matching MSAA sample count + the 2-color-
    target attachment shape used by the main render pass, and run with
    reverse-Z `greater-equal` depth compare so they composite correctly
    against the scene.
  - **Viewport wiring**: `Viewport.tsx` calls the new hook unconditionally
    whenever the user enables the IFC Annotations toggle — no section-
    plane gating, since annotations are a free-floating drawing layer.

  Deferred (no behaviour change, follow-up):

  - `IfcStyledItem` → `IfcFillAreaStyleHatching` resolution. The parser
    stubs in a default opaque dark-grey solid fill; the renderer is
    ready to consume a hatch style once the styled-item index lands.

## 1.18.0

### Minor Changes

- [#688](https://github.com/LTplus-AG/ifc-lite/pull/688) [`d0ba541`](https://github.com/LTplus-AG/ifc-lite/commit/d0ba541dda3936b985c2189fbca4300cbb89df91) Thanks [@louistrue](https://github.com/louistrue)! - Add GLB export dialog with colour-source selection and visibility
  filtering (PR [#688](https://github.com/LTplus-AG/ifc-lite/issues/688)).

  The new `GLBExportDialog` in the viewer replaces the inline GLB
  export handler in `MainToolbar` with a dedicated dialog. Features:

  - **Model picker** for federated multi-model scenes.
  - **Colour source** selector: "Rendering" (the apparent display
    colour — `IfcSurfaceStyleRendering.DiffuseColour` if authored,
    falling back to `IfcSurfaceStyleShading.SurfaceColour`) or
    "Shading" (the raw `SurfaceColour`, only available when the file
    authored a distinct `DiffuseColour`).
  - **Visible-only filter** that respects the viewer's hidden /
    isolated entity sets. Mesh-vs-set comparison runs in global ID
    space so federated models with non-zero `idOffset` filter
    correctly.
  - **Metadata inclusion** toggle for IFC GlobalId / type / name
    side-tables.

  Pipeline changes underneath:

  - `MeshData` / `MeshDataJs` carry an optional `shadingColor`
    alongside `color`. The Rust styling module now extracts both
    `IfcSurfaceStyleRendering.DiffuseColour` (rendering) and
    `IfcSurfaceStyleShading.SurfaceColour` (shading) in a single
    pre-pass and returns them as separate maps; `shadingColor` is
    only populated when it actually differs from the rendering
    colour, so memory cost stays sparse on the common case.
  - The streaming geometry path
    (`convertMeshCollectionToBatch`) and the worker collector
    (`IfcLiteMeshCollector`) both copy `shadingColor` end-to-end so
    the dialog's "Shading" source works on every load path, not just
    the batch path.
  - `GLTFExporter` gains `colorSource`, `visibleOnly`,
    `hiddenEntityIds`, and `isolatedEntityIds` options. Visibility
    filtering compares mesh `expressId` (global) against the dialog-
    supplied sets (also global) — no offset arithmetic in the
    exporter.

### Patch Changes

- [#803](https://github.com/LTplus-AG/ifc-lite/pull/803) [`b0b19ad`](https://github.com/LTplus-AG/ifc-lite/commit/b0b19ad2ea205813e599cac02c964ecdb315c6b5) Thanks [@louistrue](https://github.com/louistrue)! - Fix the wedge-shaped Z-fight artifact on the door-glass panel
  of Revit-exported `IfcDoor` fixtures (issue [#674](https://github.com/LTplus-AG/ifc-lite/issues/674) true root cause,
  PR [#802](https://github.com/LTplus-AG/ifc-lite/issues/802)).

  `process_planar_face` in `advanced_face.rs` triangulated each
  `IfcFaceBound` of an `IfcAdvancedFace` as an independent solid
  polygon, ignoring the IFC 4.3 schema's `IfcFaceOuterBound` vs
  inner-bound distinction. For a face with one outer rectangle +
  one inner hole rectangle (the door panel's glass cutout), this
  emitted:

  - outer ring: 2-tri solid quad covering the whole face
  - inner ring: 2-tri solid quad covering the hole, with the
    schema-imposed reversed winding → opposite normal

  Identical plane, opposite normals, overlapping in the cutout's
  footprint. The WebGPU pipeline runs `cullMode: 'none'`, so the
  canceling pair rendered as the visible wedge.

  Fix: identify the outer bound (preferring the typed
  `IfcType::IfcFaceOuterBound`, falling back to the first bound for
  files that emit only `IfcFaceBound`), treat siblings as holes,
  honour the per-bound orientation flag, and call the existing
  `triangulate_polygon_with_holes` helper once — the same pattern
  the FacetedBrep path in `brep.rs` already uses.

  Door panel [#712](https://github.com/LTplus-AG/ifc-lite/issues/712) on the issue-604 fixture now emits 32 triangles
  (matching IfcOpenShell's reference), up from 24 pre-fix. The
  same broken code path was the fallback for every other surface
  type in `advanced_face.rs` (B-spline edge cap, cylindrical /
  conical / spherical / toroidal / surface-of-linear-extrusion
  fallbacks); all of those now also produce correct annular
  triangulations on faces with inner bounds.

- [#803](https://github.com/LTplus-AG/ifc-lite/pull/803) [`b0b19ad`](https://github.com/LTplus-AG/ifc-lite/commit/b0b19ad2ea205813e599cac02c964ecdb315c6b5) Thanks [@louistrue](https://github.com/louistrue)! - Fix the door-handle bend rendering with the lever floating
  detached from the rosette on Revit-exported `IfcDoor` fixtures
  (issue [#674](https://github.com/LTplus-AG/ifc-lite/issues/674) redux, PR [#799](https://github.com/LTplus-AG/ifc-lite/issues/799)).

  `process_surface_of_revolution_face` in `advanced_face.rs` read
  `surface.get(1)` for the axis placement, but per IFC 4.3 the
  `IfcSurfaceOfRevolution` schema is:

  IfcSweptSurface (parent)
  0 SweptCurve
  1 Position (optional IfcAxis2Placement3D)
  IfcSurfaceOfRevolution (child)
  2 AxisPosition (IfcAxis1Placement)

  Revit exports `IFCSURFACEOFREVOLUTION(#sc,$,#ap)` — slot 1 is
  null. Reading slot 1 returned None, the fallback
  `(Point3::origin(), +Z)` kicked in, and the angular-extent
  calculation projected boundary points around (0,0,0) instead of
  the true revolution axis. The bend swept ~13° through the wrong
  region of space and the bulb ended up pointing "down and outward"
  from the rosette.

  Switched to `surface.get(2)`. AABB on the door fixture lands at
  x=[115, 245] y=[67, 122] vs IfcOpenShell's [120, 250] / [70, 120]
  (5 mm offset from tessellation density). The bulb now rotates
  through the correct quadrant and the handle connects.

## 1.17.0

### Minor Changes

- [#655](https://github.com/LTplus-AG/ifc-lite/pull/655) [`a6637a4`](https://github.com/LTplus-AG/ifc-lite/commit/a6637a41d948ec17841a0ac62586f627d0bb21fa) Thanks [@louistrue](https://github.com/louistrue)! - CSG primitive support + BSP CSG quality overhaul (issue [#780](https://github.com/LTplus-AG/ifc-lite/issues/780)):

  - **Renders the buildingSMART IFC 4.3 bath reference (`bath_csg_solid.ifc`)
    and similar `IfcCsgSolid` geometry.** Three new entity processors:

    - `IfcBlock` — axis-aligned box CSG primitive.
    - `IfcCsgSolid` — pass-through that unwraps `TreeRootExpression` to the
      matching `IfcBooleanResult` or `IfcCsgPrimitive3D` processor.
    - `IfcRoundedRectangleProfileDef` — rectangle with fillet-arc corners.
      These appear in IFC 4.3 reference content and in CSG-style authored
      models that previously emitted no geometry.

  - **BSP CSG pipeline overhaul.** Three coupled fixes that drop the bath
    reference from 189 to 59 triangles with zero sliver artifacts on the
    WASM (Manifold-free) build:

    1. **Coplanar pre-merge** in `ClippingProcessor::mesh_to_polygons`
       reassembles each input mesh's per-plane triangle clusters into
       convex N-gon polygons before BSP runs. Stops BSP from splitting
       host face diagonals at every extended cutter wall plane (the
       "spike triangle" defect on the bath).
    2. **Post-BSP coplanar consolidation** (`consolidate_coplanar`)
       re-unions per-plane fragments via the same `i_overlay` 2D union
       the rest of the codebase already uses for `bool2d::union_contours`,
       then earcuts the result with hole support — so annular faces (bath
       rim around the cavity opening) come out clean.
    3. **Collinear-vertex simplification** strips phantom vertices that
       BSP's extended planes insert on host outline edges. Without this,
       earcut emits one sliver triangle per phantom; with it, host faces
       untouched by the cutter collapse back to their original quads.

  - **Solid-solid `IfcBooleanResult.DIFFERENCE` now runs on the WASM
    build.** Previously gated to `manifold-csg` only and silently returned
    the un-cut host on the wasm32 target. The legacy BSP path already had
    its own `OperandTooLarge` guardrail (128-polygon cap with
    `BoolFailure` logging), so the conservative skip was unnecessary —
    small solid-solid cuts (e.g. CSG primitives) now subtract correctly.

  - **Dead code removal in `rust/geometry/src/csg.rs` (~470 lines).**

    - `remove_degenerate_triangles` — was nuking the bath cavity floor
      because its "strictly inside host bounds AND small ⇒ artifact"
      heuristic is structurally wrong for closed cavities. Replaced by
      the new consolidation pipeline that handles the same sliver class
      without the false positives.
    - `extract_opening_profile` — never called anywhere.
    - `clip_mesh_with_box` — deprecated wrapper around `subtract_box`, no
      callers.
    - `remove_triangles_inside_bounds` — never wired up, kept "for future
      rectangular openings" since 2024.

  - **Cross-fixture CSG quality regression** (`csg_quality_regression.rs`).
    Pins zero spike triangles (aspect ratio > 50:1) on AC20-FZK-Haus
    gable walls ([#60012](https://github.com/LTplus-AG/ifc-lite/issues/60012) / [#67828](https://github.com/LTplus-AG/ifc-lite/issues/67828), chained polygonal-bounded half-space
    clips) and on the bath fixture. Three pre-existing spike sources in
    the rectangular-opening path (duplex window [#6426](https://github.com/LTplus-AG/ifc-lite/issues/6426), advanced_model
    walls [#553010](https://github.com/LTplus-AG/ifc-lite/issues/553010) / [#612315](https://github.com/LTplus-AG/ifc-lite/issues/612315)) are pinned `#[ignore]`d with their current
    spike counts so they become tightening gates once that separate path
    is cleaned up.

  - **Stale `bool_failure_test::*_records_operand_too_large` tests
    updated.** They depended on 36 stacked-at-same-position box triangles
    exceeding a 24-polygon cap. The cap was raised to 128 in PR [#648](https://github.com/LTplus-AG/ifc-lite/issues/648) and
    the new coplanar merge collapses stacked-coincident boxes anyway;
    replaced with 30 distinct-position boxes (180 face polygons) so the
    cap-rejection path is genuinely exercised.

### Patch Changes

- [#795](https://github.com/LTplus-AG/ifc-lite/pull/795) [`bb3123a`](https://github.com/LTplus-AG/ifc-lite/commit/bb3123adcd751f4c27b4457156e2d0bae3b40e56) Thanks [@louistrue](https://github.com/louistrue)! - Fix walls sticking through curved roof slabs on AC20-Institute-Var-2
  (issue [#583](https://github.com/LTplus-AG/ifc-lite/issues/583), PR [#789](https://github.com/LTplus-AG/ifc-lite/issues/789)). The chained-polygonal-bounded-half-space code
  path used to mesh-merge every cutter in an `IfcBooleanClippingResult`
  chain into one combined cutter before running a single BSP CSG
  subtract. When the chain contained overlapping or duplicate prisms
  (Wand-010 has four chained cutters including an exact duplicate at
  `x = [17, 25]`), the merge of two closed solids occupying the same
  volume was non-manifold by construction and BSP produced sliver
  artefacts that left ~0.4-2.7 m of wall sticking through the roof.

  The fix follows the web-ifc model: drop the batching, let chains fall
  through the standard recursive single-cutter path. Each per-step
  cutter is a single closed manifold prism, structurally eliminating
  the non-manifold-cutter root cause. Two long-standing
  `IfcPolygonalBoundedHalfSpace` issues that the batched path was
  masking were also fixed: the prism now extrudes along the cutter
  Position's `+Z` axis (per the IFC 4.3 spec, not the plane's material-
  side direction), and the polygon winding is reversed against
  `Position.Z` to match the cap reversal in `build_tilted_prism_mesh`.

- [#795](https://github.com/LTplus-AG/ifc-lite/pull/795) [`bb3123a`](https://github.com/LTplus-AG/ifc-lite/commit/bb3123adcd751f4c27b4457156e2d0bae3b40e56) Thanks [@louistrue](https://github.com/louistrue)! - Fix the broken door-handle silhouette on Revit-exported `IfcDoor`
  fixtures (issue [#674](https://github.com/LTplus-AG/ifc-lite/issues/674), PR [#793](https://github.com/LTplus-AG/ifc-lite/issues/793)). `process_surface_of_revolution_face`
  collapsed each profile point's radial vector to
  `radius = sqrt(rx² + ry²)`, discarding the sign of the projection
  onto `axis_x`. Profiles that sat entirely on the `-axis_x` half of
  the axis frame — for example the Revit door-handle bulb, an
  `IfcCircle` arc whose centre is offset 15 mm from the revolution
  axis on the bar side — got mirrored to the `+axis_x` ray and rendered
  180° away from where they should sit, leaving a visible gap between
  the lever bar and the rosette.

  The sweep now rotates the profile's actual `(rx, ry)` 2D radial
  vector through the sweep angle, so profiles offset to either side of
  the axis stay on their side. Triangle counts are unchanged
  (repositioning, not re-sampling).

- [#655](https://github.com/LTplus-AG/ifc-lite/pull/655) [`a6637a4`](https://github.com/LTplus-AG/ifc-lite/commit/a6637a41d948ec17841a0ac62586f627d0bb21fa) Thanks [@louistrue](https://github.com/louistrue)! - Geometry correctness fixes from the calibration-report sweep (PR [#655](https://github.com/LTplus-AG/ifc-lite/issues/655)):

  - **W410x60 / wide-flange profile area is now correct to within arc-sampling
    noise.** Revit authors I-beams as `IfcArbitraryClosedProfileDef` whose
    composite curve mixes long polyline edges with short fillet-arc edges;
    the over-tessellated-curve detector was misclassifying the mix as a smooth
    curve and RDP was slicing across the polyline corners, adding ~4.3 % to
    the swept volume. Now gated on a longest-edge/diagonal ratio so mixed-
    geometry profiles bypass simplification entirely.

  - **Walls authored with `IfcExtrudedAreaSolid` profiles whose aspect ratio
    exceeds 100:1 no longer emit as hollow tubes.** The cap-skip threshold
    caught normal residential interior walls (115 mm × 12 m = ratio 103),
    dropping their top/bottom faces. Raised to 10000:1 — only genuinely
    pathological profiles trigger the skip now.

  - **Opening extension no longer wipes the wall when the opening's
    extrusion axis maps to the wall's long axis.** Two new gates skip the
    extension heuristic when (a) the opening already spans the wall in the
    extrusion direction (advanced_model [#553010](https://github.com/LTplus-AG/ifc-lite/issues/553010), a 300 mm horizontal slot),
    and (b) the wall extends further along the extrusion direction than the
    opening's longest dimension (advanced_model [#612315](https://github.com/LTplus-AG/ifc-lite/issues/612315), a 115 mm column
    whose Position transform rotates +Z onto the wall's 11.8 m long axis).
    Six previously-failing calibration walls now produce correct cuts.

  - **New `Mesh::welded()` and `Mesh::welded_by_position()` APIs** on the
    Rust mesh type for opt-in vertex deduplication. Default emission stays
    unwelded triangle soup so GPU consumers keep per-face flat normals;
    call sites that need a manifold mesh (volume queries, CSG, watertight
    checks) can opt in. Welding the duplex M_Fixed window drops vertex
    count from 180 → 48 (3.75×) and pushes manifold-edge fraction from
    32 % to 95 %. JS-side exposure is a separate follow-up.

## 1.16.10

### Patch Changes

- [#605](https://github.com/louistrue/ifc-lite/pull/605) [`1d6e99b`](https://github.com/louistrue/ifc-lite/commit/1d6e99bb23f67e20a192f362ba65ee73a8180f69) Thanks [@louistrue](https://github.com/louistrue)! - Fix the three Revit-door geometry defects called out in #604: opening-cut
  slivers when the opening's depth equals the host wall's depth, missing door
  handle hardware (`IfcAdvancedBrep` over `IfcSurfaceOfRevolution` and
  `IfcCylindricalSurface`), and broken door glazing. The opening extension now
  overshoots the wall by a unit-independent pad whose floor is strictly above
  the rectangular clipper's epsilon, surfaces of revolution are tessellated
  from their generator profile and recovered angular extent, and circular edge
  boundaries are sampled along the arc instead of collapsing to two-point
  loops.

- [#648](https://github.com/louistrue/ifc-lite/pull/648) [`b6e83d3`](https://github.com/louistrue/ifc-lite/commit/b6e83d3ac4f04fe7c439bf282a25963c6db0b909) Thanks [@louistrue](https://github.com/louistrue)! - Fix `IfcBooleanClippingResult` on walls clipped by `IfcPolygonalBoundedHalfSpace` (issue #635).

  Three related fixes that together restore correct geometry on walls whose body is a chained `IfcBooleanClippingResult`:

  1. **Round-window voids reach the post-clip mesh.** The `IfcOpeningElement` cut path now runs against the boolean-clipped wall mesh rather than the un-clipped extrusion, so windows and doors are subtracted from the actual visible wall body.
  2. **Polygonal-bounded half-space orientation.** The cutter prism is built by extruding the polygon along Position's Z-axis (per the IFC spec) instead of along the slope plane normal — gable walls #60012 and #67828 in AC20-FZK-Haus now narrow to a peak and span the full wall length at the bottom (was: inverted, point-down).
  3. **Chained polygonal half-space clips compose correctly.** When two `IfcPolygonalBoundedHalfSpace` cuts are stacked (one per gable side), the cutter prisms are now MERGED into a single mesh and applied in ONE BSP CSG op. Previously the first cut's output exceeded `MAX_CSG_POLYGONS_PER_MESH`, causing the second cut to silently drop and leaving a flat horizontal cap at the gable apex.

  Round-window opening profiles are also simplified before triangulation so AC20-style 36-segment circles fit under the CSG polygon budget instead of falling back to a square hole. CSG kernel diagnostics (`take_failures`) now surface every silent skip — including the `PolygonalBoundedHalfSpaceFallback` path — so callers can warn on geometry loss.

- [#644](https://github.com/louistrue/ifc-lite/pull/644) [`6f052c3`](https://github.com/louistrue/ifc-lite/commit/6f052c309a99edd1d9a6925d44bbc2aed6cd10a5) Thanks [@louistrue](https://github.com/louistrue)! - Add "Merge Multilayer Walls" load-time toggle (issue #540).

  When enabled, every `IfcBuildingElementPart` whose `IfcRelAggregates`
  parent wall (a) has its own `Representation` and (b) is sliceable in
  `MaterialLayerIndex` is suppressed during geometry emission. The parent
  wall's single swept solid keeps the per-layer sub-mesh colouring via the
  existing slicer, so the visual result on multilayer walls is the same as
  the layered render — but with one mesh per wall instead of N per-layer
  parts. Designed for large Revit-exported models where the per-layer
  extrusions inflate vertex counts beyond what the viewer can handle.

  New JS surface on `IfcAPI`:

  ```ts
  setMergeLayers(enabled: boolean): void
  ```

  Defaults to `false`. Honoured by `parseMeshes`, `parseMeshesSubset`,
  `parseMeshesAsync`, `parseMeshesInstanced`, `parseMeshesInstancedAsync`,
  `processGeometryBatch`, and `processGeometryBatchParallel`. The batch
  paths cache the parts-to-skip set on `IfcAPI` so workers build it once
  per content and reuse across every batch; the cache is cleared by
  `clearPrePassCache` and by `setMergeLayers`.

  Voids stay correct: `propagate_voids_to_parts` already copies the
  parent wall's `IfcRelVoidsElement` references onto its layer parts in
  the same pass that builds the part → parent map, so windows and doors
  still cut through the merged solid.

- [#575](https://github.com/louistrue/ifc-lite/pull/575) [`b8a8206`](https://github.com/louistrue/ifc-lite/commit/b8a82062c4392d05224561dda8a2767a8b7b1857) Thanks [@louistrue](https://github.com/louistrue)! - Add regression tests for non-box `IfcOpeningElement` classification (#547). PR #640 already routes low-tessellation non-rectangular openings (trapezoids, chamfered rectangles, beveled windows, coarse arcs) through CSG via `is_rectangular_box_mesh` + `infer_opening_frame`. This change adds end-to-end coverage that loads inline IFC fixtures and asserts the cut respects the actual opening profile (trapezoid narrow-edge boundary vertices appear in the voided wall, and many tessellated-box openings on a single wall are all cut without the CSG-budget cap silently dropping any).

## 1.16.9

### Patch Changes

- [#640](https://github.com/louistrue/ifc-lite/pull/640) [`8408c88`](https://github.com/louistrue/ifc-lite/commit/8408c88c4c0a1e848fade6c60474952eca1a4149) Thanks [@louistrue](https://github.com/louistrue)! - Fix diagonal and roof-window opening cuts. Oblique multilayer wall parts keep
  their opening soffits within the actual wall geometry, BRep roof openings
  preserve their full sloped opening frame instead of falling back to world axes,
  and roof windows on shallow-slope roofs are no longer routed through unstable
  full CSG by a too-aggressive "vertical extrusion ⇒ floor opening" heuristic —
  classification is now per-item based on whether the opening mesh is actually a
  clean rectangular box.

- [#641](https://github.com/louistrue/ifc-lite/pull/641) [`ba7553a`](https://github.com/louistrue/ifc-lite/commit/ba7553af693939896a840074999b5f6806a94815) Thanks [@louistrue](https://github.com/louistrue)! - Fix `IfcReinforcingBar` stirrup rendering (issue #631, sample
  `IfcReinforcingBar.ifc`).

  `IfcSweptDiskSolid` directrixes that use `IfcIndexedPolyCurve` over
  `IfcCartesianPointList3D` (typical for stirrups and other bent rebar that
  lives outside the XY plane) used to fall back to a 2D parser that read x/y
  from indices 0–1 and silently dropped the Z coordinate. The stirrup
  collapsed onto z=0 and the resulting tube was a flat near-degenerate line.

  The 3D curve dispatcher now has a native arm for `IfcIndexedPolyCurve` that
  reads `IfcCartesianPointList2D` (z=0) or `IfcCartesianPointList3D` verbatim
  and fits `IfcArcIndex` segments using a circumcircle in the plane of their
  three control points. Straight schema conformance — no spec deviation.

  The second sample on the issue (`Rebar2.ifc`) was already rendering its
  directrix correctly under the existing segment-index trim path; no change
  needed there.

## 1.16.8

### Patch Changes

- [#610](https://github.com/louistrue/ifc-lite/pull/610) [`f3d8b1d`](https://github.com/louistrue/ifc-lite/commit/f3d8b1d3d7c15488ebd0bdd2b44c0ed4cb25254a) Thanks [@louistrue](https://github.com/louistrue)! - Two follow-ups to the `IfcSweptDiskSolid` trim-param fix from #606, plus the rebuilt WASM artifact that actually lands the trim-param logic at runtime (CI does not rebuild the WASM binary; consumers were still on the pre-#606 binary).

  - **Junction-point dedup is now coordinate-aware.** When concatenating trimmed composite-curve segments, the previous implementation unconditionally dropped the first point of each subsequent segment — fine when adjacent segments share a coordinate-identical junction vertex, but it silently distorted directrices whose adjacent segments meet at non-coincident endpoints (model drift, mismatched cartesian points). The first point is now dropped only when it coincides with the last point already collected (`< 1e-6`), preserving the gap otherwise.

  - **Cross-section frame no longer flips at sharp bends.** `SweptDiskSolidProcessor` was re-picking the perpendicular `up` vector at every cross-section based on `tangent.x.abs() < 0.9`; consecutive tangents that straddled the threshold flipped the sign of `perp1`, so the same vertex index pointed to opposite angular positions on consecutive rings — visible as a twisted / flat-ribbon tube at L-bends and rebar hooks. Replaced with a Rotation-Minimising Frame: `up` is chosen once for the first sample, and each subsequent frame is propagated by the minimum rotation that aligns the previous tangent onto the current tangent (Rodrigues). Adds three unit tests covering straight-line invariance, 90° L-bend non-flip, and degenerate-input handling.

- [#606](https://github.com/louistrue/ifc-lite/pull/606) [`7d3a40b`](https://github.com/louistrue/ifc-lite/commit/7d3a40b5268491325b8496fc56181818b2141e6e) Thanks [@joepaddock-uk](https://github.com/joepaddock-uk)! - Honor `IfcSweptDiskSolid.StartParam` / `EndParam` for `IfcCompositeCurve` and `IfcPolyline` directrices. Previously these were silently ignored, so a swept disk solid like `IFCSWEPTDISKSOLID(#dir, 0.0095, $, 0., 1.)` with a 3-segment composite-curve directrix swept the entire curve instead of just segment `[0,1]` — most visible in rebar models authored by Revit/Tekla, where bars rendered 3-5× their real length with end hooks unfolded into the bar geometry.

  The dispatch now honors trim parameters for the two directrix types whose IFC parameterisation is unambiguous from the entity:

  - `IfcCompositeCurve` (and subtypes via `is_subtype_of`): segment-index based, each segment contributes 1.0 to the parameter.
  - `IfcPolyline`: point-index based, each segment between consecutive points contributes 1.0.

  Boundary segments are truncated by linear interpolation along the sampled polyline (exact for piecewise-linear input). Out-of-range params clamp; inverted ranges (`StartParam ≥ EndParam`) produce empty geometry. Other directrix types (`IfcLine`, `IfcCircle`, `IfcTrimmedCurve`, `IfcBSplineCurve`) still ignore trim — their parameterisations are length / angle / knot-based and need separate handling — flagged as a known limitation.

  Adds 11 unit tests in `profiles::tests` covering: full-range identity, exact-half boundaries, strict-interior comparisons, two-point partial trim, fractional multi-segment trim with dedup, out-of-range clamping, inverted ranges, `SameSense=F` reverse-then-trim semantics, and direct-polyline-directrix paths.

## 1.16.7

### Patch Changes

- [#596](https://github.com/louistrue/ifc-lite/pull/596) [`945bb30`](https://github.com/louistrue/ifc-lite/commit/945bb30061ca044f4a51001f7299c17350ce99cf) Thanks [@louistrue](https://github.com/louistrue)! - Render `IfcSolarDevice` (and any future `IfcEnergyConversionDevice` / `IfcDistributionElement` subtype) without code changes.

  The geometry pipeline previously gated entities through a hand-maintained leaf-level whitelist (`has_geometry_by_name`) and a hand-maintained leaf-level "secondary priority" blacklist (`is_simple_geometry_type`). New IFC4X3 subtypes silently fell through both — `IfcSolarDevice`, which inherits from `IfcEnergyConversionDevice`, was the latest casualty (PR #585).

  Both functions now derive their answer from the EXPRESS inheritance graph via `IfcType::is_subtype_of`, so any subtype of an already-supported parent is picked up automatically. The legacy IFC2x3 / removed-in-IFC4x3 names not in the modern enum are resolved through the existing `legacy_entities` registry, which already carries a `has_geometry` flag per entry.

  `has_geometry_by_name` also moved out of `rust/core/src/generated/schema.rs` (which is marked "DO NOT EDIT — auto-generated") into a new sibling module `schema_helpers.rs`, so a future re-run of `@ifc-lite/codegen` won't wipe it.

  Co-authored with @geronimi73 (PR #585).

- [#572](https://github.com/louistrue/ifc-lite/pull/572) [`18c6a37`](https://github.com/louistrue/ifc-lite/commit/18c6a37f1cc1426daa32ee60457dd0580a5257f5) Thanks [@louistrue](https://github.com/louistrue)! - Restore inner reveal faces for window and door openings cut from walls, with axis-clamped quads that work for any wall orientation. Rebuilds the WASM bundle with the new reveal generation and defensive guards (full cross-axis overlap check + orthogonal-axis clamp) so multi-layer wall sub-meshes never receive floating reveal quads and skipped openings from the triangle-cap safety path don't leave phantom interior faces.

## 1.16.6

### Patch Changes

- [#563](https://github.com/louistrue/ifc-lite/pull/563) [`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966) Thanks [@louistrue](https://github.com/louistrue)! - Slice single-solid walls by `IfcMaterialLayerSetUsage` so each layer renders in its own material colour. Sub-millimetre layers fold into their thicker neighbour so the clipper never sees degenerate interfaces, and slicing bails cleanly when the representation isn't a single item with an identity Position (multi-item reps, MappedItems, or translated extrusions fall through to the unsliced path).

- [#563](https://github.com/louistrue/ifc-lite/pull/563) [`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966) Thanks [@louistrue](https://github.com/louistrue)! - Subtract voids per sub-mesh so multi-layer walls keep their layer colours after opening cuts (#541). Previously merging the void subtraction onto the combined mesh collapsed all per-item style information, so doors and windows in material-segmented walls came out uniformly coloured.

## 1.16.5

### Patch Changes

- [#565](https://github.com/louistrue/ifc-lite/pull/565) [`7000011`](https://github.com/louistrue/ifc-lite/commit/7000011d6eb372c2dadf7c82f6e76a0583c6abc1) Thanks [@louistrue](https://github.com/louistrue)! - Rebuild WASM bindings for model-level RTC and georeferenced federation alignment fixes.

## 1.16.4

### Patch Changes

- [#519](https://github.com/louistrue/ifc-lite/pull/519) [`643b30f`](https://github.com/louistrue/ifc-lite/commit/643b30ff031d389fe0cb1caf7de6989d79629e4b) Thanks [@louistrue](https://github.com/louistrue)! - Fix geometry processing hang on models with 500K+ geometry elements

  Cache entity index from buildPrePassOnce and reuse it across processGeometryBatch calls, eliminating redundant full-file scans. Cap batch count at 30 to prevent excessive per-batch overhead for models with very high geometry element counts.

## 1.16.3

### Patch Changes

- [#526](https://github.com/louistrue/ifc-lite/pull/526) [`cb59771`](https://github.com/louistrue/ifc-lite/commit/cb59771997e3837a511f584842bce98cd710864e) Thanks [@louistrue](https://github.com/louistrue)! - Restore toNativeBuffer in native-bridge and add Tauri stub aliases to desktop vite config.

## 1.16.2

### Patch Changes

- [#502](https://github.com/louistrue/ifc-lite/pull/502) [`05fd49f`](https://github.com/louistrue/ifc-lite/commit/05fd49f3fded214c5c5f59c61b0b55fcb7457f7b) Thanks [@louistrue](https://github.com/louistrue)! - Fix large direct `GeometryProcessor.processStreaming()` and `processInstancedStreaming()` calls by switching oversized IFC inputs to the existing byte-based WASM pre-pass and batch pipeline instead of decoding the entire file into a single JavaScript string first, and expose the supporting byte-based instanced batch API from `@ifc-lite/wasm`.

## 1.16.1

### Patch Changes

- [#474](https://github.com/louistrue/ifc-lite/pull/474) [`7a1aeb7`](https://github.com/louistrue/ifc-lite/commit/7a1aeb7fabdb4b9692d02186fe4254fc561bece4) Thanks [@louistrue](https://github.com/louistrue)! - Fix advanced face tessellation: add rational B-spline (NURBS) weight support, SameSense winding correction, and knot vector validation

## 1.16.0

### Minor Changes

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Add LOD geometry generation, profile projection for 2D drawings, and streaming server integration

### Patch Changes

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Fix I-beam profile shading with corrected circular profile detection threshold, two-sided lighting, and winding reversal for mirrored profiles

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Fix IFC4X3 RTC offset detection by using both simple and complex geometry jobs for sampling

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Fix multilayer wall parts not getting window/door cutouts by propagating void relationships from parent walls to child IfcBuildingElementPart entities

## 1.15.0

### Minor Changes

- [#439](https://github.com/louistrue/ifc-lite/pull/439) [`a672eec`](https://github.com/louistrue/ifc-lite/commit/a672eec196ec77b0229b0953f9a1b59991f814a6) Thanks [@louistrue](https://github.com/louistrue)! - Remove wasm-bindgen-rayon thread infrastructure and rebuild WASM binary without atomics/shared-memory. Pin wasm-bindgen to 0.2.106. Add `parseMeshesSubset`, `buildPrePassOnce`, and `processGeometryBatch` APIs for parallel Web Worker geometry processing. Enable WASM SIMD128 for faster geometry math. Fix exponential triangle growth in rectangular opening clipping by merging adjacent openings. Add NaN guards and bounds checks in clipping code. Reduce boolean recursion depth limit to prevent stack overflow.

## 1.14.6

### Patch Changes

- [#432](https://github.com/louistrue/ifc-lite/pull/432) [`113bafc`](https://github.com/louistrue/ifc-lite/commit/113bafc07436c809a8cb24d8682cf63ae5ed99e9) Thanks [@louistrue](https://github.com/louistrue)! - Regenerate the WASM bindings with support for `IfcDerivedProfileDef` and `IfcMirroredProfileDef` profile transforms so derived swept profiles render correctly.

- [#432](https://github.com/louistrue/ifc-lite/pull/432) [`113bafc`](https://github.com/louistrue/ifc-lite/commit/113bafc07436c809a8cb24d8682cf63ae5ed99e9) Thanks [@louistrue](https://github.com/louistrue)! - Include the generated `pkg/snippets` worker helper files in the published `@ifc-lite/wasm` package so bundlers can resolve the wasm-bindgen rayon import at runtime.

## 1.14.5

### Patch Changes

- [#411](https://github.com/louistrue/ifc-lite/pull/411) [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515) Thanks [@louistrue](https://github.com/louistrue)! - Fix large model loading with streaming columnar parser, inline scan worker, and improved geometry bridge. Refactor relationship graph for better memory efficiency and add spatial index builder utilities.

- [#412](https://github.com/louistrue/ifc-lite/pull/412) [`f0da00c`](https://github.com/louistrue/ifc-lite/commit/f0da00c162f2713ed9144691d52c75a21faa18dd) Thanks [@louistrue](https://github.com/louistrue)! - Refactor void clipping helpers, material styling, and submesh color resolution for improved readability and maintainability.

## 1.14.4

### Patch Changes

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Fix arc angle wrapping for profiles crossing the 0°/360° boundary

## 1.14.3

### Patch Changes

- [#330](https://github.com/louistrue/ifc-lite/pull/330) [`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45) Thanks [@louistrue](https://github.com/louistrue)! - Remove the unused `@ifc-lite/parser` runtime dependency from `@ifc-lite/mutations`, switch `@ifc-lite/server-bin` postinstall to a safe ESM dynamic import, and refresh the published `@ifc-lite/wasm` bindings and binary so the npm package stays in sync with the current Rust sources.

## 1.14.2

## 1.14.1

### Patch Changes

- [#283](https://github.com/louistrue/ifc-lite/pull/283) [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607) Thanks [@louistrue](https://github.com/louistrue)! - fix: support large IFC files (700MB+) in geometry streaming

  - Add error handling to `collectInstancedGeometryStreaming()` to prevent infinite hang when WASM fails
  - Add adaptive batch sizing for large files in `processInstancedStreaming()`
  - Add 0-result detection warnings when WASM returns no geometry
  - Replace `content.clone()` with `Option::take()` in all async WASM methods to halve peak memory usage

## 1.14.0

## 1.13.0

## 1.12.0

## 1.11.3

## 1.11.1

## 1.11.0

### Patch Changes

- [#232](https://github.com/louistrue/ifc-lite/pull/232) [`ca7fd20`](https://github.com/louistrue/ifc-lite/commit/ca7fd2015923e5a1a330ccbc4e95d259f9ce9c6f) Thanks [@louistrue](https://github.com/louistrue)! - Fix window rendering and interaction regressions for multi-part tessellated elements. The WASM geometry pipeline now correctly triangulates `IfcIndexedPolygonalFaceWithVoids` (including inner loops) and respects optional `PnIndex` remapping, restoring correct window cutouts and subelement colors. Renderer picking, CPU raycasting, and selected-mesh lazy creation now handle all submesh pieces per element/model instead of collapsing to a single piece, and selected highlights are rendered after transparent passes so glass receives the same selection highlight as frames.

## 1.10.0

### Minor Changes

- [#203](https://github.com/louistrue/ifc-lite/pull/203) [`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8) Thanks [@louistrue](https://github.com/louistrue)! - Add visual enhancement post-processing (contact shading, separation lines, edge contrast) and fix geometry parsing / entity type resolution

  **Renderer — visual enhancements:**

  - Add fullscreen post-processing pass (`PostProcessor`) with depth-based contact shading and object-ID-based separation lines for improved visual clarity between adjacent elements
  - Add configurable edge contrast enhancement via shader uniforms with adjustable intensity
  - New `VisualEnhancementOptions` API with independent quality presets (`off` / `low` / `high`), intensity, and radius for contact shading, separation lines, and edge contrast
  - Automatically disable expensive effects on mobile devices

  **Renderer — render pipeline changes:**

  - Add second render target (`rgba8unorm` object ID texture) to all render pipelines (opaque, transparent, overlay, instanced) for per-entity boundary detection
  - Expand vertex format from 6 to 7 floats (position + normal + entityId) across all pipelines and the picker
  - Encode entity IDs into the object ID texture via 24-bit RGB encoding in fragment shaders
  - Depth texture now created with `TEXTURE_BINDING` usage for post-processor sampling
  - Edge contrast rendering made conditional via uniform flags (`flags.z` / `flags.w`) instead of always-on

  **Renderer — geometry & scene:**

  - `GeometryManager` interleaves entity ID into the 7th float of each vertex buffer
  - `Scene` batching writes entity IDs per-vertex into merged buffers for instanced rendering

  **Data — entity type system expansion:**

  - Add ~30 new `IfcTypeEnum` entries: chimney, shading device, building element part, element assembly, reinforcing bar/mesh/tendon, discrete accessory, mechanical fastener, flow controller/moving device/storage device/treatment device/energy conversion device, duct/pipe/cable segments, furniture, proxy, annotation, transport element, civil element, geographic element
  - Add ~11 new type definition enums: pile type, member type, plate type, footing type, covering type, railing type, stair type, ramp type, roof type, curtain wall type, building element proxy type
  - Map `*StandardCase` variants (e.g. `IFCSLABSTANDARDCASE`, `IFCCOLUMNSTANDARDCASE`) to their base enum values for correct grouping
  - Expand `TYPE_STRING_TO_ENUM` and `TYPE_ENUM_TO_STRING` maps with all new types
  - Add new `ifc-entity-names.ts` with 888-line UPPERCASE → PascalCase lookup table (all IFC4X3 entity names) for correct display of any IFC entity type
  - Add `rawTypeName` field to `EntityTableBuilder` storing normalized type name as string index
  - `getTypeName()` now falls back to `rawTypeName` for types not in the enum, eliminating "Unknown" display for valid IFC types

  **Parser:**

  - Add diagnostic `console.debug` logging for spatial entity extraction and `console.warn` on extraction failures

  **WASM / Rust geometry engine:**

  - Replace overly broad geometry entity filter (`starts_with("IFC") && !ends_with("TYPE") && ...`) with explicit whitelist of ~120 IfcProduct subtypes in `has_geometry_by_name`, preventing non-product entities (e.g. `IfcDimensionalExponents`, `IfcSurfaceStyleRendering`) from being sent to geometry processing
  - Add `SolidModel` to the accepted representation types in the geometry router (6 match arms)
  - Use smooth per-vertex normals for extruded circular profiles (cylinder side walls) with `is_approximately_circular_profile` heuristic that detects circular vs polygonal profiles by coefficient of variation of radii from centroid
  - Increase circle tessellation from 24 to 36 segments for profiles (circle, circle hollow, trimmed curve, ellipse)
  - Increase swept disk solid tube segments from 12 to 24 for smoother pipes
  - Fix `PolygonalFaceSet` processing: generate flat-shaded meshes with per-face normals via `build_flat_shaded_mesh` and fix closed-shell winding orientation via `orient_closed_shell_outward`
  - Improve geometry extraction statistics: separate "no representation" (expected) from actual processing failures in diagnostic logging
  - Add `console.debug` logging for entities skipped due to missing representation

  **Viewer app:**

  - Add visual enhancement state to Zustand UI slice with 10 configurable properties (enabled, edge contrast enabled/intensity, contact shading quality/intensity/radius, separation lines enabled/quality/intensity/radius)
  - Wire `VisualEnhancementOptions` through `Viewport`, `useAnimationLoop`, and `useRenderUpdates` via memoized ref pattern
  - Show IFC type name instead of "Unknown" for spatial entities with generic names in the tree hierarchy
  - Expand `useThemeState` hook with all visual enhancement selectors

## 1.9.0

## 1.8.0

## 1.7.0

## 1.5.0

### Minor Changes

- [#162](https://github.com/louistrue/ifc-lite/pull/162) [`463e7c9`](https://github.com/louistrue/ifc-lite/commit/463e7c934abc2fccd0a35a8eab04fbae47185259) Thanks [@louistrue](https://github.com/louistrue)! - Add symbolic representation support for 2D drawings

  - **New Feature**: Added `parseSymbolicRepresentations` WASM API to extract 2D Plan, Annotation, and FootPrint representations from IFC files
  - **New Feature**: Section2DPanel now supports toggling between section cuts and symbolic representations (architectural floor plans)
  - **New Feature**: Added hybrid mode that combines section cuts with symbolic representations
  - **New Feature**: Building rotation detection from IfcSite placement for proper floor plan orientation
  - **Enhancement**: RTC offset streaming events for better coordinate handling in large models
  - **Enhancement**: Geometry processor now reports building rotation in coordinate info
  - **Types**: Added `SymbolicRepresentationCollection`, `SymbolicPolyline`, `SymbolicCircle` types

## 1.3.0

### Minor Changes

- [#139](https://github.com/louistrue/ifc-lite/pull/139) [`0c1a262`](https://github.com/louistrue/ifc-lite/commit/0c1a262d971af4a1bc2c97d41258aa6745fef857) Thanks [@louistrue](https://github.com/louistrue)! - Add PolygonalFaceSetProcessor and surface model processors for improved geometry support

  ### New Geometry Processors

  - **PolygonalFaceSetProcessor**: Handle IfcPolygonalFaceSet with triangulation of arbitrary polygons
  - **FaceBasedSurfaceModelProcessor**: Process IfcFaceBasedSurfaceModel geometry
  - **SurfaceOfLinearExtrusionProcessor**: Handle IfcSurfaceOfLinearExtrusion surfaces
  - **ShellBasedSurfaceModelProcessor**: Process IfcShellBasedSurfaceModel geometry

  ### Performance Optimizations

  - Add fast-path decoder functions with point caching for BREP-heavy files (~2x faster)
  - Add `get_first_entity_ref_fast`, `get_polyloop_coords_fast`, `get_polyloop_coords_cached`
  - Add `has_non_null_attribute()` for fast attribute filtering
  - Optimize FacetedBrep with fast-path using `get_face_bound_fast`
  - Add WASM-specific sequential iteration to avoid threading overhead

### Patch Changes

- [#119](https://github.com/louistrue/ifc-lite/pull/119) [`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3) Thanks [@louistrue](https://github.com/louistrue)! - Fix WASM safety, improve DX, and add test infrastructure

  - Replace 60+ unsafe unwrap() calls with safe JS interop helpers in WASM bindings
  - Clean console output with single summary line per file load
  - Pure client-side by default (no CORS errors in production)
  - Add unit tests for StringTable, GLTFExporter, store slices
  - Add WASM contract tests and integration pipeline tests
  - Fix TypeScript any types and data corruption bugs

- [#117](https://github.com/louistrue/ifc-lite/pull/117) [`4bf4931`](https://github.com/louistrue/ifc-lite/commit/4bf4931181d1c9867a5f0f4803972fa5a3178490) Thanks [@louistrue](https://github.com/louistrue)! - Fix multi-material rendering and enhance CSG operations

  ### Multi-Material Rendering

  - Windows now correctly render with transparent glass panels and opaque frames
  - Doors now render all submeshes including inner framing with correct colors
  - Fixed mesh deduplication in Viewport that was filtering out submeshes sharing the same expressId
  - Added SubMesh and SubMeshCollection types to track per-geometry-item meshes for style lookup

  ### CSG Operations

  - Added union and intersection mesh operations for full boolean CSG support
  - Improved CSG clipping with degenerate triangle removal to eliminate artifacts
  - Enhanced bounds overlap detection for better performance
  - Added cleanup of triangles inside opening bounds to remove CSG artifacts

- [#135](https://github.com/louistrue/ifc-lite/pull/135) [`07558fc`](https://github.com/louistrue/ifc-lite/commit/07558fc4aa91245ef0f9c31681ec84444ec5d80e) Thanks [@louistrue](https://github.com/louistrue)! - Fix RTC (Relative To Center) coordinate handling consistency

  **BREAKING**: Rename `isGeoReferenced` to `hasLargeCoordinates` in CoordinateInfo interface.
  Large coordinates do NOT mean a model is georeferenced. Proper georeferencing uses IfcMapConversion.

  - Rename isGeoReferenced → hasLargeCoordinates across all packages (geometry, cache, export, viewer)
  - Fix transform_mesh to apply RTC uniformly per-mesh (not per-vertex) preventing mixed coordinates
  - Fix coordinate-handler.ts threshold consistency between bounds calculation and vertex cleanup
  - Fix streaming path originalBounds reconstruction by undoing server-applied shift
  - Surface RTC offset in GpuGeometry struct with JS-accessible getters (rtcOffsetX/Y/Z, hasRtcOffset)
  - Add RTC detection and offset handling to parseToGpuGeometryAsync
  - Include RTC offset in GPU async completion stats
  - Add comprehensive coordinate handling documentation

## 1.2.1

### Patch Changes

- Version sync with @ifc-lite packages

## 1.2.0

### Minor Changes

- f4fbf8c: ### New Features

  - **2D Profile-Level Boolean Operations**: Implemented efficient 2D polygon boolean operations for void subtraction at the profile level before extrusion. This provides 10-25x performance improvement over 3D CSG operations for most openings and produces cleaner geometry with fewer degenerate triangles.

  - **Void Analysis and Classification**: Added intelligent void classification system that distinguishes between coplanar voids (can be handled efficiently in 2D) and non-planar voids (require 3D CSG). This enables optimal processing strategy selection.

  - **Enhanced Void Handling**: Improved void subtraction in extrusions with support for both full-depth and partial-depth voids, including segmented extrusion for complex void configurations.

  ### Improvements

  - **WASM Compatibility**: Replaced `clipper2` (C++ dependency) with `i_overlay` (pure Rust) for WASM builds, eliminating C++ compilation issues and ensuring reliable WASM builds.

  - **Performance**: Profile-level void subtraction is significantly faster than 3D CSG operations, especially for floors/slabs with many penetrations.

- ed8f77b: ### New Features

  - **IFC5 (IFCX) Format Support**: Added full support for IFC5/IFCX file format parsing, enabling compatibility with the latest IFC standard
  - **IFCX Property/Quantity Display**: Enhanced viewer to properly display IFCX properties and quantities
  - **IFCX Coordinate System Handling**: Fixed coordinate system transformations for IFCX files

  ### Bug Fixes

  - **Fixed STEP Escaping**: Corrected STEP file escaping issues that affected IFCX parsing
  - **Fixed IFC Type Names**: Improved IFC type name handling for better compatibility

- f4fbf8c: ### New Features

  - **Type visibility controls**: Toggle visibility of spatial elements (IfcSpace, IfcOpeningElement, IfcSite) in the viewer toolbar
  - **Enhanced CSG operations**: Improved boolean geometry operations using the `csgrs` library for better performance and accuracy
  - **Full IFC4X3 schema support**: Migrated to generated schema with all 876 IFC4X3 types

  ### Bug Fixes

  - **Fixed unit conversion**: Files using millimeters (.MILLI. prefix) now render at correct scale instead of 1000x too large
  - **Fixed IFCPROJECT detection**: Now scans entire file to find IFCPROJECT instead of only first 100 entities, fixing issues with large IFC files

- ed8f77b: ### Performance Improvements

  - **Lite Parsing Mode**: Added optimized parsing mode for large files (>100MB) with 5-10x faster parsing performance
  - **On-Demand Property Extraction**: Implemented on-demand property extraction for instant property access, eliminating upfront table building overhead
  - **Fast Semicolon Scanner**: Added high-performance semicolon-based scanner for faster large file processing
  - **Single-Pass Data Extraction**: Optimized to single-pass data extraction for improved parsing speed
  - **Async Yields**: Added async yields during data parsing to prevent UI blocking
  - **Bulk Array Extraction**: Optimized data model decoding with bulk array extraction for better performance
  - **Dynamic Batch Sizing**: Implemented dynamic batch sizing for improved performance in IFC processing with adaptive batch sizes based on file size

  ### New Features

  - **On-Demand Parsing Mode**: Consolidated to single on-demand parsing mode for better memory efficiency
  - **Targeted Spatial Parsing**: Added targeted spatial parsing in lite mode for efficient hierarchy building

  ### Bug Fixes

  - **Fixed Relationship Graph**: Added DefinesByProperties to relationship graph in lite mode
  - **Fixed On-Demand Maps**: Improved forward relationship lookup for rebuilding on-demand maps
  - **Fixed Property Extraction**: Restored on-demand property extraction when loading from cache

- f7133a3: ### Performance Improvements

  - **Zero-copy WASM memory to WebGPU upload**: Implemented direct memory access from WASM linear memory to WebGPU buffers, eliminating intermediate JavaScript copies. This provides 60-70% reduction in peak RAM usage and 40-50% faster geometry-to-GPU pipeline.

  - **Optimized cache and spatial hierarchy**: Eliminated O(n²) lookups in cache and spatial hierarchy builder, implemented instant cache lookup with larger batches, and optimized batch streaming for better performance.

  - **Parallelized data model parsing**: Added parallel processing for data model parsing and streaming of cached geometry with deferred hash computation and yielding before heavy decode operations.

  ### New Features

  - **Zero-copy benchmark suite**: Added comprehensive benchmark suite to measure zero-copy performance improvements and identify bottlenecks.

  - **GPU geometry API**: Added new GPU-ready geometry API with pre-interleaved vertex data, pre-converted coordinates, and pointer-based direct WASM memory access.

  ### Bug Fixes

  - **Fixed O(n²) batch recreation**: Eliminated inefficient batch recreation in zero-copy streaming pipeline.

  - **Updated WASM and TypeScript definitions**: Updated WASM bindings and TypeScript definitions for geometry classes to support zero-copy operations.

### Patch Changes

- ed8f77b: ### Bug Fixes

  - **Fixed Color Parsing**: Fixed TypedValue wrapper handling in color parsing
  - **Fixed Storey Visibility**: Fixed storey visibility toggle functionality
  - **Fixed Background Property Parsing**: Added background property parsing support
  - **Fixed Geometry Support**: Added IfcSpace/Opening/Site geometry support
  - **Fixed TypeScript Generation**: Fixed TypeScript generation from EXPRESS schema types
  - **Fixed Renderer Safeguards**: Added renderer safeguards for proper IFC type names

- ### Bug Fixes

  - **Fixed IFC elevation units**: IFC files store elevation values in the file's native units (e.g., mm), but they were being displayed as meters without conversion. Now properly extracts and applies length unit scale from IFCPROJECT -> IFCUNITASSIGNMENT -> IFCSIUNIT/IFCCONVERSIONBASEDUNIT, supporting SI prefixes (MILLI, CENTI, etc.) and imperial units (FOOT, INCH).
  - **Fixed IFCMEASUREWITHUNIT scale**: When extracting conversion factors from IFCMEASUREWITHUNIT, the ValueComponent is now correctly multiplied by the UnitComponent's scale factor (e.g., INCH defined as 25.4mm = 0.0254m).
  - **Fixed missing IFCUNITASSIGNMENT handling**: Added guards against missing IFCUNITASSIGNMENT attributes to prevent parsing errors.

- ### Improvements

  - **Optimized WASM build configuration**: Removed unnecessary compilation flags and streamlined WASM build process for better performance and smaller binary size (~10% reduction).
  - **Improved WASM memory management**: Enhanced WASM JavaScript bindings for better memory management and performance.
  - **Removed unused threading dependencies**: Removed unused rayon threading imports and configurations, simplifying the WASM package.
  - **Simplified Vite configuration**: Refactored Vite configuration for WASM handling, removing unnecessary file copying and exclusion logic.

## 1.2.0

### Minor Changes

- [#39](https://github.com/louistrue/ifc-lite/pull/39) [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **2D Profile-Level Boolean Operations**: Implemented efficient 2D polygon boolean operations for void subtraction at the profile level before extrusion. This provides 10-25x performance improvement over 3D CSG operations for most openings and produces cleaner geometry with fewer degenerate triangles.

  - **Void Analysis and Classification**: Added intelligent void classification system that distinguishes between coplanar voids (can be handled efficiently in 2D) and non-planar voids (require 3D CSG). This enables optimal processing strategy selection.

  - **Enhanced Void Handling**: Improved void subtraction in extrusions with support for both full-depth and partial-depth voids, including segmented extrusion for complex void configurations.

  ### Improvements

  - **WASM Compatibility**: Replaced `clipper2` (C++ dependency) with `i_overlay` (pure Rust) for WASM builds, eliminating C++ compilation issues and ensuring reliable WASM builds.

  - **Performance**: Profile-level void subtraction is significantly faster than 3D CSG operations, especially for floors/slabs with many penetrations.

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **IFC5 (IFCX) Format Support**: Added full support for IFC5/IFCX file format parsing, enabling compatibility with the latest IFC standard
  - **IFCX Property/Quantity Display**: Enhanced viewer to properly display IFCX properties and quantities
  - **IFCX Coordinate System Handling**: Fixed coordinate system transformations for IFCX files

  ### Bug Fixes

  - **Fixed STEP Escaping**: Corrected STEP file escaping issues that affected IFCX parsing
  - **Fixed IFC Type Names**: Improved IFC type name handling for better compatibility

- [#39](https://github.com/louistrue/ifc-lite/pull/39) [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **Type visibility controls**: Toggle visibility of spatial elements (IfcSpace, IfcOpeningElement, IfcSite) in the viewer toolbar
  - **Enhanced CSG operations**: Improved boolean geometry operations using the `csgrs` library for better performance and accuracy
  - **Full IFC4X3 schema support**: Migrated to generated schema with all 876 IFC4X3 types

  ### Bug Fixes

  - **Fixed unit conversion**: Files using millimeters (.MILLI. prefix) now render at correct scale instead of 1000x too large
  - **Fixed IFCPROJECT detection**: Now scans entire file to find IFCPROJECT instead of only first 100 entities, fixing issues with large IFC files

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### Performance Improvements

  - **Lite Parsing Mode**: Added optimized parsing mode for large files (>100MB) with 5-10x faster parsing performance
  - **On-Demand Property Extraction**: Implemented on-demand property extraction for instant property access, eliminating upfront table building overhead
  - **Fast Semicolon Scanner**: Added high-performance semicolon-based scanner for faster large file processing
  - **Single-Pass Data Extraction**: Optimized to single-pass data extraction for improved parsing speed
  - **Async Yields**: Added async yields during data parsing to prevent UI blocking
  - **Bulk Array Extraction**: Optimized data model decoding with bulk array extraction for better performance
  - **Dynamic Batch Sizing**: Implemented dynamic batch sizing for improved performance in IFC processing with adaptive batch sizes based on file size

  ### New Features

  - **On-Demand Parsing Mode**: Consolidated to single on-demand parsing mode for better memory efficiency
  - **Targeted Spatial Parsing**: Added targeted spatial parsing in lite mode for efficient hierarchy building

  ### Bug Fixes

  - **Fixed Relationship Graph**: Added DefinesByProperties to relationship graph in lite mode
  - **Fixed On-Demand Maps**: Improved forward relationship lookup for rebuilding on-demand maps
  - **Fixed Property Extraction**: Restored on-demand property extraction when loading from cache

- [#52](https://github.com/louistrue/ifc-lite/pull/52) [`f7133a3`](https://github.com/louistrue/ifc-lite/commit/f7133a31320fdb8e8744313f46fbfe1718f179ff) Thanks [@louistrue](https://github.com/louistrue)! - ### Performance Improvements

  - **Zero-copy WASM memory to WebGPU upload**: Implemented direct memory access from WASM linear memory to WebGPU buffers, eliminating intermediate JavaScript copies. This provides 60-70% reduction in peak RAM usage and 40-50% faster geometry-to-GPU pipeline.

  - **Optimized cache and spatial hierarchy**: Eliminated O(n²) lookups in cache and spatial hierarchy builder, implemented instant cache lookup with larger batches, and optimized batch streaming for better performance.

  - **Parallelized data model parsing**: Added parallel processing for data model parsing and streaming of cached geometry with deferred hash computation and yielding before heavy decode operations.

  ### New Features

  - **Zero-copy benchmark suite**: Added comprehensive benchmark suite to measure zero-copy performance improvements and identify bottlenecks.

  - **GPU geometry API**: Added new GPU-ready geometry API with pre-interleaved vertex data, pre-converted coordinates, and pointer-based direct WASM memory access.

  ### Bug Fixes

  - **Fixed O(n²) batch recreation**: Eliminated inefficient batch recreation in zero-copy streaming pipeline.

  - **Updated WASM and TypeScript definitions**: Updated WASM bindings and TypeScript definitions for geometry classes to support zero-copy operations.

### Patch Changes

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### Bug Fixes

  - **Fixed Color Parsing**: Fixed TypedValue wrapper handling in color parsing
  - **Fixed Storey Visibility**: Fixed storey visibility toggle functionality
  - **Fixed Background Property Parsing**: Added background property parsing support
  - **Fixed Geometry Support**: Added IfcSpace/Opening/Site geometry support
  - **Fixed TypeScript Generation**: Fixed TypeScript generation from EXPRESS schema types
  - **Fixed Renderer Safeguards**: Added renderer safeguards for proper IFC type names
