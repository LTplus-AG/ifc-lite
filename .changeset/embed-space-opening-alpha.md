---
'@ifc-lite/viewer-embed': patch
---

Stop the embed re-multiplying `IfcSpace` and `IfcOpeningElement` alpha, so it draws the same store the full viewer does.

**Default appearance changes for hosts that show spaces or openings.** Both are off by default (`TYPE_VISIBILITY_SEMANTIC_DEFAULTS.spaces` and `.openings` are `false`), so an embed that never turns them on is unaffected: those meshes are filtered out before this pass and were never drawn. A host that switches either on, through `setTypeVisibility` or a persisted preference, now sees them at the alpha the Rust styling table assigns (`IfcSpace` 0.3, `IfcOpeningElement` 0.4) rather than the 0.09 and 0.12 the clamp produced. They look roughly three times more solid. That is the appearance the full viewer has had since #677.

`useModelViewGeometry` re-multiplied both classes down to `Math.min(alpha * 0.3, 0.3)` after the visibility filter. `ViewportContainer` removed exactly that under #677, because it stomped lens and property-set colour rules even when the caller had explicitly chosen alpha 1.0, and because the defaults already carry the translucency so applying it twice was never intended. The embed kept it, so the same protocol against the same store produced two pictures.

When it bit: the clamp lived in a React memo, so it only reached the GPU on an upload from that mesh list. That is the initial load, a model swap, colours applied while streaming was still running, and any type-visibility toggle, which re-uploads the visible set. The sequence that reproduces it is colour a space, then turn spaces on, and the space comes back at 0.3.

When it did not: a colour sent after load is unaffected. `SET_COLORS` also queues `pendingMeshColorUpdates`, which `useGeometryStreaming` pushes straight into `scene.updateMeshColors`, while the geometry effect takes its early return on an unchanged mesh count. In that ordering the embed already drew the host's alpha.
