---
"@ifc-lite/geometry": patch
---

Cap the cut face of unbounded `IfcHalfSpaceSolid` differences (gable roof-trims, mono-pitch eaves, Revit top-trims).

The pure-Rust kernel consolidation (#1024) deleted the in-tree BSP kernel along with the polygon cap that closed the cross-section left by the fast plane-clip path, but kept that path for unbounded `IfcHalfSpaceSolid` operands. With no cap, every such clip produced an **open, inverted shell** (negative signed volume, dozens of open boundary edges) instead of a watertight solid — the roof-clipped wall rendered as a broken/spiky surface.

The clip now re-closes the section: it chains the on-plane open boundary into loops, classifies them into outer rings and holes, triangulates each region with the kernel CDT, and winds the cap to face the removed side. If the boundary is non-manifold or does not close (a non-watertight host), it bails and leaves the output unchanged — never worse than before.

On AC20-FZK-Haus the two roof-clipped upper walls go from `14 tris / −8.4 m³ / 16 open edges` to `20 tris / +2.06 m³ / 0 open edges`; void-cut walls are untouched.
