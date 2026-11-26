---
"@ifc-lite/renderer": patch
---

The opt-in draw stream no longer compiles a render pipeline on the frame. When it first engages, or when the edge pass switches on or off mid-gesture, it draws with an already built twin that paints the same pixels, or leaves the frame to the per-batch loop until the background build lands. Each such switch used to cost one frame of about 100 ms on Windows GPUs.
