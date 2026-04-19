---
'@ifc-lite/renderer': minor
'@ifc-lite/csg': minor
'viewer': patch
---

Add filled, hatched 3D section cap surfaces and scaffold a CSG export package.

- `@ifc-lite/renderer`: new `SectionCapRenderer` draws a winding-independent
  stencil-parity cap fill with screen-space hatches (diagonal, cross-hatch,
  concrete, brick, insulation, …) wherever the section plane intersects a
  solid. The main, instanced, and section-plane/overlay pipelines now declare
  both render-pass colour targets (main colour + picker objectId) so the cap
  pass shares the same attachments without triggering "Incompatible color
  attachments" validation errors. The `flipped` slider flag is honoured in
  both the main clip and the cap, and the pipelines' depth format is
  `depth24plus-stencil8`.
- `@ifc-lite/csg`: new package scaffolding an offline "bake the cut into
  exportable IFC geometry" flow. `subtractHalfspace()` handles the AABB fast
  path today; the straddling mesh path is intentionally stubbed so the
  package can ship alongside the realtime renderer changes without pulling
  the manifold-3d CSG work into scope.
- `viewer`: section panel exposes hatch pattern, fill/stroke colour, spacing
  and angle. Moving the slider auto-enables the clip so users don't get
  stuck in "the plane moves but nothing cuts".
