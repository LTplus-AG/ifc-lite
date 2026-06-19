---
"@ifc-lite/renderer": patch
---

Fix lens/IDS/compare/4D colour overlays silently failing to paint. The
anti-z-fight depth nudge in the vertex shader folded the per-draw `baseColor`
into its hash, so the colour-override overlay (drawn over the base geometry
with `depthCompare: 'equal'`) computed a different nudged depth than the base
pass — material colour vs. override colour — and every overlay fragment was
rejected. Symptom: the lens panel reported "N coloured" but the 3D model stayed
its default colour.

The depth nudge now reads an 8-bit material-colour salt baked into the high 8
bits of the per-vertex entity-id lane (low 24 bits remain the picking id, which
`encodeId24` masks the salt off of), instead of the draw-time `baseColor`. The
base and overlay passes therefore compute an identical nudge — so the overlay's
`equal` depth test matches and colour paints — while distinct material layers
still receive distinct depths, preserving the coplanar-layer separation. Picking
is unaffected.
