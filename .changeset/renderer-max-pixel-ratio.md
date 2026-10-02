---
'@ifc-lite/renderer': minor
---

Add `Renderer.setMaxPixelRatio(ratio)`, which caps the drawing buffer's device-pixel ratio below the default of 2. Since the drawing buffer follows the display's device pixels, a large viewport on a 2x screen fills four times the pixels it did at CSS resolution, and on a large model that fill is what limits the frame rate. An app can now choose CSS resolution, or anything between, for the frame rate. A non-finite or non-positive ratio falls back to the default.
