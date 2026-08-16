---
'@ifc-lite/renderer': minor
---

Add `Renderer.setClashIntersectionSolid` — draw a clash's true overlap volume as an opaque solid.

The clash panel used to mark a focused clash with a contact point or a wireframe overlap box. Neither shows depth, shape, or direction the way BIMcollab Zoom / Solibri's opaque intersection-solid presentation does. This adds the render half: a small dedicated GPU pipeline (`ClashSolidPipeline`) that draws an arbitrary triangle mesh opaque, depth-tested and depth-writing like ordinary geometry — unlike the existing `SymbolicFillPipeline` decal it shares a shader with, which deliberately does not write depth because it draws flat annotation fills coplanar with a real surface.

Depth-writing matters here specifically because the two clashing (parent) elements are meant to be ghosted translucent around the solid: ghosted geometry already renders with `depthWriteEnabled: false`, so the solid — drawn after it in the same pass — shows through the ghost and still resolves correctly against any unrelated opaque geometry in front of it.

`setClashIntersectionSolid(null)` clears it; it is independent of the existing `setClashOverlapBox` / `setClashContactLines`, which remain the fallback presentation when the caller has no solid to show (e.g. `clashIntersectionSolid` returned a degenerate reason).
