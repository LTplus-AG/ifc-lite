---
"@ifc-lite/wasm": patch
"@ifc-lite/geometry": patch
---

Fix `IfcReinforcingBar` rendering for two real-world rebar shapes (issue #631).

**3D `IfcIndexedPolyCurve` directrix support.** `IfcSweptDiskSolid` directrixes
that use `IfcIndexedPolyCurve` over `IfcCartesianPointList3D` (typical for
stirrups and other bent rebar that lives outside the XY plane) used to fall
back to a 2D parser that read x/y from indices 0–1 and silently dropped the Z
coordinate. The stirrup collapsed onto z=0 and the resulting tube was a flat
near-degenerate line. The 3D curve dispatcher now has a native arm for
`IfcIndexedPolyCurve` that reads 3D point lists verbatim and fits arc segments
(`IfcArcIndex`) using a circumcircle in the plane of their three control
points. This is straight schema conformance — no spec deviation.

**SPEC DEVIATION (Revit rebar): arc-length fallback for non-conformant
`IfcSweptDiskSolid` trim parameters.** Per IFC4 / IFC4.3, an `IfcCompositeCurve`
with `n` segments is parameterised over `[0, n]` — each segment contributes
exactly 1.0 — so `IfcSweptDiskSolid.StartParam` / `.EndParam` are segment-index
parameters. Revit (and similar AECC tools) emit `EndParam` in arc length along
the directrix instead, typically the bar's swept length in the file's length
unit. Clamping to `num_segments` per spec made bars render at 10–100× their
real length.

`get_composite_curve_points_trimmed` now detects `EndParam > num_segments + ε`
(impossible under the spec) and re-interprets the parameters as arc length,
trimming the sampled directrix by cumulative length. Spec-conformant inputs
(`EndParam ≤ num_segments`) take the unchanged segment-index path and behave
bit-identically to the previous implementation. The deviation, detection rule,
and reasoning are documented in the method's doc comment and flagged at the
branch point.
