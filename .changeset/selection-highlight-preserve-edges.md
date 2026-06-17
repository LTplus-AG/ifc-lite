---
"@ifc-lite/renderer": patch
---

Keep internal edges/facets visible on selected objects.

The selection highlight painted every fragment a single flat blue (`color = vec3(0.3, 0.6, 1.0)`), discarding all lighting. Because the viewer's "internal lines" are really the per-face shading step of flat-shaded facets, that flat fill collapsed a selected object into one featureless silhouette — creases and bends disappeared the moment it was highlighted (the faint screen-space edge line alone could not stand in for the lost face-shading cue).

The highlight now re-lights a selection-blue albedo with the scene's own lighting term instead of overwriting it. The base material colour never enters the result (no green-site / red-roof bleed-through, the reason the flat override existed), but the per-face brightness variation is preserved, so internal edges read on the highlight exactly as they do unselected. A multiplicative gain on the lighting luminance keeps sunlit faces at full selection-blue, with a floor/ceiling clamp so shadowed faces only dim and bright scenes never wash out.
