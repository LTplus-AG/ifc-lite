---
"@ifc-lite/renderer": minor
---

Replace "contact shading" with real screen-space ambient occlusion ([#5384](https://github.com/LTplus-AG/ifc-lite/issues/5384)). The old pass took 4 taps (8 on `high`) 1-3 px from each pixel and compared raw reverse-Z depth values, so at BIM viewing distances it measured almost nothing: room corners, wall-floor junctions and a building's contact with its site got no darkening.

`RenderOptions.visualEnhancement.contactShading` keeps its name and now drives an SAO-style pass. It reconstructs view-space positions and normals from the depth buffer (perspective and orthographic cameras), takes a per-pixel rotated spiral of taps inside a world-space radius, ignores geometry beyond that radius, smooths the result with a depth-aware blur, and multiplies it onto the frame. The sky and background are never darkened, and the pass is still paused while navigating on GPUs that miss frames.

- `radius` is now in world units (metres for IFC models), clamped to 0.05-10, default 1. It used to be pixels, clamped to 1-3.
- `quality`: `'low'` runs at half resolution with 12 taps, `'high'` at full resolution with 16 taps. `'off'` allocates nothing.
- `intensity` stays 0-1 (clamped); the default is now 0.8.
- The two AO targets are allocated on the first AO frame, follow the drawing-buffer size, and are released when AO is switched off.
