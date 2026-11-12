---
"@ifc-lite/viewer": patch
---

A file opened the moment the start screen appears no longer waits for the start screen's 3D mark. The mark now starts at the first idle moment instead of with the screen's first render, and never starts if a file was opened before then. Creating its WebGL context and linking its shaders took 2-3 s of main-thread time right after first paint where WebGL runs on ANGLE's Vulkan backend or on software GL; on Metal and Direct3D it was well under 0.2 s. The mark looks and behaves the same once it appears.
