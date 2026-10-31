---
"@ifc-lite/viewer": patch
---

Navigation no longer drops to exactly 30 fps on mid-range hardware. The interaction render throttle is driven by the renderer's encode cost (not swap-chain backpressure) and snaps its cap to whole display refresh intervals with half a frame of slack, so the 25 ms tier no longer throttles a 60 Hz display and the 33 ms tier holds a steady 30 fps instead of flapping. The scale-bar readout re-renders only when its text changes, and re-applying a viewpoint with an unchanged projection mode no longer writes the store.
