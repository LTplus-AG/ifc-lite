---
"@ifc-lite/wasm": minor
---

CSG primitive support + BSP CSG quality overhaul (issue #780):

- **Renders the buildingSMART IFC 4.3 bath reference (`bath-csg-solid.ifc`)
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
  gable walls (#60012 / #67828, chained polygonal-bounded half-space
  clips) and on the bath fixture. Three pre-existing spike sources in
  the rectangular-opening path (duplex window #6426, advanced_model
  walls #553010 / #612315) are pinned `#[ignore]`d with their current
  spike counts so they become tightening gates once that separate path
  is cleaned up.

- **Stale `bool_failure_test::*_records_operand_too_large` tests
  updated.** They depended on 36 stacked-at-same-position box triangles
  exceeding a 24-polygon cap. The cap was raised to 128 in PR #648 and
  the new coplanar merge collapses stacked-coincident boxes anyway;
  replaced with 30 distinct-position boxes (180 face polygons) so the
  cap-rejection path is genuinely exercised.
