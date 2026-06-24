---
"@ifc-lite/renderer": minor
---

renderer: add `Renderer.setOverlayLineColor(rgba)` so the 3D overlay lines (annotation / alignment / grid) and the section-cut outline are themeable. The line shader previously hardcoded black, leaving these lines invisible on dark backgrounds; the colour now comes from a uniform and defaults to opaque black (no behaviour change unless set). Complements `SymbolicTextInput.color`, which already themes the matching labels.
