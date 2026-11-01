---
"@ifc-lite/viewer": patch
---

Keep the render loop from running ahead of the GPU: it now holds a frame back while three submitted frames are still unfinished, so selection picks no longer wait behind a backlog of orbit and inertia frames on slow (software) GPUs. Output on a GPU that keeps up is unchanged.
