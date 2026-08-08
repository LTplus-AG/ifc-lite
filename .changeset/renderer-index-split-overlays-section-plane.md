---
"@ifc-lite/renderer": patch
---

Internal file split: move the overlay layer and the per-frame section-plane resolution out of `index.ts`, which was 3946 lines against the ~400-line house rule (issue #2425).

- `renderer-overlays.ts` (`RendererOverlays`) now owns the section-plane gizmo, the 2D section drawing / cut cap, and the standalone 3D line overlays (IfcAnnotation lines, IfcAlignment centrelines, IfcGridAxis, the DXF reference layer, and the focused clash's box / contact lines). They were already one unit in everything but location: created together in `init()`, destroyed together in `destroy()`, drawn consecutively at the tail of the render pass.
- `renderer-symbolic-overlays.ts` (`SymbolicOverlays`) owns the symbolic fill + text pipelines, which are a genuinely separate pair of GPU objects sharing no state with the `Section2DOverlayRenderer` behind the cap and the line layers. `RendererOverlays` composes it and keeps the draw order, which is the one thing the two families share.
- `render-section-plane.ts` (`resolveSectionPlaneFrame`) owns the per-frame clip-plane resolution: the bounds aggregation the section slider is expressed in, the terrain-clip and explicit-plane branches, and the one-shot diagnostic.

`index.ts` goes 3946 -> 3499 lines.

**No behaviour change and no public API change.** Every moved method keeps a one-line delegate on `Renderer`, so the exported surface is byte-identical — `scripts/api-surface.json` needs no update. The move was verified against `main` by normalised diff (indentation, comments and the `this.` prefix stripped): the section-plane body, the overlay draw body, the upload facade and the camera-basis math all compare identical, and the nine-call overlay draw sequence is unchanged. The renderer suite stays at 494 tests with the same 111 suites.

This is a `patch` because consumers do receive different built code even though nothing they can call has changed.
