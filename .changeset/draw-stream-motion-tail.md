---
'@ifc-lite/renderer': patch
---

The opt-in draw stream records no render bundles while the camera moves. Nodes without a bundle for the current pick pattern or mode draw directly. Prewarm runs between frames only while the camera rests, and warms all four draw modes, including the object-id variants navigation switches to. Orbit and fly frames no longer pay for bundle recording, which the GPU process encodes. With every mode warmed, each node holds up to eight cached bundles instead of four.
