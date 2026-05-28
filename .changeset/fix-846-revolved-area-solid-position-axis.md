---
"@ifc-lite/wasm": patch
---

Fix `IfcRevolvedAreaSolid` rendering when the solid's `Position` is not
identity or the revolution axis is offset from the profile origin
(issue #846).

The old `RevolvedAreaSolidProcessor` had two bugs:

1. It ignored the `Position` (`IfcAxis2Placement3D`) attribute that
   places the swept solid's coordinate system in the enclosing
   representation. The profile and axis values were used as-if in the
   final object coord system.
2. It misused the 2D profile vertex `(x, y)` as `(radius, height)`
   along the axis — only correct when the axis runs through the
   profile origin along the profile's Y axis. For the reporter's beam
   the axis sits 1.3 m offset from the profile and points along −Y,
   so the old code produced a tiny ring near the axis line instead of
   the authored 45° I-beam sweep.

The fix applies `parse_axis2_placement_3d` to lift the swept-solid
local coords into the surrounding object frame and rotates each
profile vertex around the axis line using a proper Rodrigues
decomposition into parallel and perpendicular components relative to
the axis direction.

Second follow-up: after the cap topology was fixed by earcut, the rendered
I-beam profile still came out as a smooth blob because the side quads and
caps shared profile-ring vertices — the viewer's vertex-normal averaging
blended the flange face normal with the perpendicular web face normal at
every sharp 90° crease in the IPE200 cross-section. Flat-shade the whole
revolved solid (per-triangle vertex duplication, each triangle carries its
own face normal) so creases stay crisp.

Regression coverage:

- `rust/geometry/tests/issue_846_revolved_beam.rs` — drives the reporter's
  beam-varying-extrusion-paths fixture. Asserts beam #227 sweeps an arc
  ≥ 0.9 m long with a ≥ 0.15 m perpendicular profile extent, that beam
  #210 (plain extrusion) is unaffected, that the cap triangulation is
  manifold (no edge shared by 3+ triangles), and that the mesh ships
  per-triangle normals so the renderer can't re-smooth the creases.

Fixture `tests/models/issues/846_revolved_beam.ifc` (4.4 KB) added to
the manifest.

This PR was branched on top of PR #847 (issue #842 — IfcRationalBSplineSurfaceWithKnots),
so the manifest update here also carries an `issues/842_rational_bspline_surface.ifc`
entry inherited from that base. Once #847 lands on `main` and this PR
rebases, the 842 entry will already be on main and the diff collapses to
just the 846 entry. Documented per PR #848 review (coderabbit Minor) so
the scope of the manifest delta is clear.
