---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

fix(geometry): cut Tekla flush recesses/notches/slots with real boolean (#977)

Recess and notch openings (one end flush with a host face, or a shallow slot on
a non-solid section) were cut with the analytic AABB clip, which fabricates
reveal/cap walls assuming a solid host. On steel sections (channels, beams,
round tubes) those walls hang in empty space — a thin residual face, or a
bloated box wrapping the member. Such openings now take a real Manifold boolean
subtraction, which only emits cut faces where material actually exists. The cut
box is grown outward on faces flush with the host so the cut penetrates cleanly
without over-cutting; genuine through-openings (doors/windows) stay on the
analytic path. Also retunes the Manifold cutter perturbation to clear the
kernel's host-relative coplanarity tolerance, and stops rendering
`IfcOpeningElement` void cutters as standalone solids.
