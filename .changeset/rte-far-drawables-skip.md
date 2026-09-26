---
"@ifc-lite/renderer": patch
---

Selecting in a model with an element more than 1,000 km from the camera no longer throws `RTE drawable origin exceeds the ±1000000 m camera-relative envelope` (#6128). The pick pass draws every visible mesh without culling, so one far-off element (a stray placement, or a second model on another grid) failed every click; the colour, shadow, instanced, point-cloud and overlay passes had the same latent failure. A drawable outside the camera's relative-to-eye envelope cannot be rasterised in that frame, so each pass now skips it (instanced draws are split into in-envelope runs) instead of failing. Invalid source coordinates still throw.
