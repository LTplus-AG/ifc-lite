---
'@ifc-lite/renderer': patch
'@ifc-lite/viewer': patch
---

Render the 3D canvas at the display's device-pixel resolution, and stop flooring its width to a multiple of 64 (#5383). The drawing buffer now follows the element's CSS size times `devicePixelRatio` (capped at 2, and lowered uniformly on both axes when the GPU's max texture dimension would be exceeded), so HiDPI screens get a sharp image instead of an upscaled CSS-resolution one, and the buffer's aspect matches the element's, so the view is no longer stretched sideways. Sizes authored in CSS pixels stay the same on screen at every density: point-cloud splats, symbolic text, section-cap hatching, contact shading, separation lines, eye-dome lighting, snap tolerances and the small-object cull thresholds. Picking keeps rendering at CSS resolution, so a click costs the same as before. In the viewer, wheel and pinch zoom-to-cursor and the orbit pivot pair CSS cursor coordinates with the CSS extent instead of the drawing-buffer width, and the scale bar and the adaptive fit read CSS sizes.
