---
"@ifc-lite/renderer": minor
---

Clash visualisation support:

- Add `RenderOptions.highlightColors` — a per-element highlight tint. An id in this map glows in the given RGBA using the re-lit selection treatment (and gets the same individual-mesh / opaque / stay-solid-through-ghost handling) **without** needing to be in the store selection. Lets a consumer render, e.g., the two sides of a clash in distinct vibrant colours in highlight/isolate/ghost with no "selected" state.
- Add `Renderer.setClashOverlapBox(box | null)` — draws a world-space AABB as a distinct-colour wireframe box (e.g. the clash overlap region) via the existing overlay line pipeline. Pass `null` to clear.

(#1277/#1339)
