---
'@ifc-lite/renderer': minor
'viewer': patch
---

3D section cap with screen-space hatches, driven by exact cut polygons.

- `@ifc-lite/renderer`: the 3D section cap now renders through
  `Section2DOverlayRenderer`'s fill pass instead of a stencil-parity
  approximation. Fill silhouette comes from `SectionCutter`
  (triangle-plane intersection per element), so the 3D cap is
  mathematically identical to the 2D section drawing on the same model —
  no more stray hatch over empty sky or above-plane geometry on
  non-manifold IFC. Screen-space hatch patterns (diagonal, cross-hatch,
  concrete, brick, insulation, horizontal, vertical, solid) are painted
  directly on the polygon fills with user-defined fill/stroke colours
  and spacing. Depth format switched to `depth24plus-stencil8`; section
  plane, 2D overlay, and main pipelines all declare both render-pass
  colour targets so the pass validates. The main shader clip respects
  the section `flipped` flag in both batched and instanced paths.
- `viewer`: section panel exposes hatch pattern, fill/stroke colours,
  spacing, angle, and width, with labels wired to controls for assistive
  tech. Flip button now reflects its pressed state. Slider and axis
  buttons auto-enable the clip so users don't get stuck in "preview
  mode". Cap style (colours + hatch) persists across reloads via
  localStorage; axis, position, and enabled stay session-scoped.
