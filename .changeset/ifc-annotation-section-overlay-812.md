---
"@ifc-lite/viewer": minor
"@ifc-lite/renderer": patch
---

Make IFC annotation overlays usable in real drawings (issue #812 follow-up
to the annotation text feature):

- **3D z-fight fix**: annotation lines, fills, and text pipelines now apply
  a reverse-Z `depthBias` / `depthBiasSlopeScale` so a label drawn exactly
  on a wall/floor face no longer disappears or strobes. This was the user-
  reported "coplanar glitch" — the per-fragment depth-equal pass plus MSAA
  jitter was the actual cause, not line weight. The pipelines remain
  `depthCompare: 'greater-equal'` so foreground geometry still occludes the
  overlay correctly.

- **Annotations in 2D section views**: the Section 2D panel now overlays
  IfcAnnotation curves, text, and fills on the section drawing when their
  authored storey elevation falls inside the cut's view-range on the cut
  axis. New `showIfcAnnotations` flag on `drawing2DDisplayOptions` (defaults
  on) and a header toggle (Tag icon, next to Symbolic-vs-Cut) wire it up.
  The toggle is currently active only for floor-plan views (`axis='down'`);
  elevation/section axes need a separate coord-reorientation pass and are
  disabled in the UI.

The 2D path reuses the existing module-global parse cache from
`useSymbolicAnnotations`, so the WASM symbolic-representation parse runs
at most once per loaded model regardless of how many overlay surfaces are
active.
