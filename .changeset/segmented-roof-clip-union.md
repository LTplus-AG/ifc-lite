---
"@ifc-lite/wasm": patch
"@ifc-lite/geometry": patch
---

fix(geometry): union segmented-roof clip cutters to stop wall slivers and dropped walls (#960)

Gable walls trimmed by a segmented roof are authored as deep left-deep
`IfcBooleanClippingResult(.DIFFERENCE., x, IfcPolygonalBoundedHalfSpace)`
chains (one cutter per roof plane). Two defects on House.ifc:

- Walls clipped by 12+ roof planes blew the boolean recursion-depth limit and
  rendered as nothing.
- Sequentially subtracting abutting roof-segment prisms left a zero-thickness,
  full-height fin on the shared seam — a thin wall sliver poking through the
  roof.

The chain is now walked iteratively and the cutter prisms are combined with a
true CSG union before a single subtract, so the seam face is dissolved and the
depth limit no longer bites. Two guards keep the well-tested per-cutter path
for full-cross-section clips (duplex.ifc "Party Wall") and reject any union the
kernel silently under-removes. Output is mm-identical to IfcOpenShell on all
five reported walls.
