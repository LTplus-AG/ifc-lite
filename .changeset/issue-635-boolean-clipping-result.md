---
"@ifc-lite/wasm": patch
---

Fix `IfcBooleanClippingResult` on walls clipped by `IfcPolygonalBoundedHalfSpace` (issue #635).

Three related fixes that together restore correct geometry on walls whose body is a chained `IfcBooleanClippingResult`:

1. **Round-window voids reach the post-clip mesh.** The `IfcOpeningElement` cut path now runs against the boolean-clipped wall mesh rather than the un-clipped extrusion, so windows and doors are subtracted from the actual visible wall body.
2. **Polygonal-bounded half-space orientation.** The cutter prism is built by extruding the polygon along Position's Z-axis (per the IFC spec) instead of along the slope plane normal — gable walls #60012 and #67828 in AC20-FZK-Haus now narrow to a peak and span the full wall length at the bottom (was: inverted, point-down).
3. **Chained polygonal half-space clips compose correctly.** When two `IfcPolygonalBoundedHalfSpace` cuts are stacked (one per gable side), the cutter prisms are now MERGED into a single mesh and applied in ONE BSP CSG op. Previously the first cut's output exceeded `MAX_CSG_POLYGONS_PER_MESH`, causing the second cut to silently drop and leaving a flat horizontal cap at the gable apex.

Round-window opening profiles are also simplified before triangulation so AC20-style 36-segment circles fit under the CSG polygon budget instead of falling back to a square hole. CSG kernel diagnostics (`take_failures`) now surface every silent skip — including the `PolygonalBoundedHalfSpaceFallback` path — so callers can warn on geometry loss.
