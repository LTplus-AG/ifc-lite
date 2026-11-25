---
'@ifc-lite/renderer': patch
---

The opt-in draw stream records no render bundles while the camera moves. A mixed-LOD node draws directly instead of re-recording its bundle every time its pick pattern changes. Prewarm runs only at rest, asks for idle frames until done, and also warms the object-id variants. Orbit and fly frames no longer pay for bundle recording, which the GPU process encodes.
