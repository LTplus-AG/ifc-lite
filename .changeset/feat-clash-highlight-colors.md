---
"@ifc-lite/renderer": minor
---

Add `RenderOptions.highlightColors` — a per-element highlight tint for selected meshes. A selected mesh whose id is in this map glows in the given RGBA using the same re-lit selection treatment instead of the default selection blue. Lets a consumer render, e.g., the two sides of a clash in distinct vibrant colours while keeping the selection glow, crease structure and opacity. Only applied to ids that are also selected (`selectedId`/`selectedIds`); absent map = unchanged behaviour. (#1277/#1339)
