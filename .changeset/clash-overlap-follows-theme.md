---
"@ifc-lite/renderer": minor
---

`setClashOverlapBox`, `setClashContactLines` and `setClashIntersectionSolid` accept an optional `color` (#5490). Omit it and the overlap marks are drawn in the overlay theme's `clashOverlap`, and are recoloured in place by a later `setOverlayTheme` call, so a theme switch while a clash is focused no longer leaves the previous theme's tint on screen. An explicit `color` behaves exactly as before. `DEFAULT_OVERLAY_THEME`'s clash tints are now the viewer's light-theme clash tokens rather than the retired amber / cyan / magenta; nothing in the renderer read those fields before this change.
