---
"@ifc-lite/renderer": patch
---

`setOverlayTheme` now repaints a focused clash pair (#5490). The pair is painted through `Scene.setColorOverrides`, whose overlay batches bake the colour in, so a theme switch left the previous theme's tints on screen. Any installed colour override exactly equal to the previous theme's `clashA` / `clashB` is now rebuilt in the new theme's values; other override colours are untouched, and nothing is rebuilt when neither tint changes. `Scene.setColorOverrides` also deep-copies the colours it retains, so a caller that later mutates a tuple it passed in can no longer make `getColorOverrides()` disagree with what is drawn.
