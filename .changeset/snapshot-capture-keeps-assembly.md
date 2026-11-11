---
"@ifc-lite/renderer": patch
---

A scene-snapshot capture no longer turns off the streamed finalize's GPU assembly. While a capture is armed, each streamed fragment keeps the vertex bytes it uploaded. An assembled batch then hands the capture those bytes, concatenated in the order of the GPU copy, with its rebased indices and LOD1 indices. Before, a capture forced every bucket through the full CPU merge, quantize and upload, so a cold load that stores its scene (the first-reopen snapshot) lost the assembly's saving. The snapshot bytes are unchanged: they equal what the GPU draws, as before. A fragment drawn before the capture was armed has no kept bytes, so its bucket rebuilds (`render.finalize.rebuilt.capture`).
