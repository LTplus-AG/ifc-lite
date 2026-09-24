---
"@ifc-lite/renderer": minor
---

Replace the separation-line post pass with a real edge pass ([#5385](https://github.com/LTplus-AG/ifc-lite/issues/5385)). The old pass fired only on an entity-id change, read a fixed 1-3 px tap of raw (non-linear, reverse-Z) depth, and thresholded that as a hard boolean; storey joints on a flush facade flickered into dashed lines because the per-pixel slope crossed the threshold, not the geometry, and a wall's own corners or a roof ridge got no line at all since nothing there changes entity id.

`RenderOptions.visualEnhancement.separationLines` keeps its name and now drives the edge pass. It shares the ambient-occlusion pass's depth reconstruction (`depth-reconstruct.ts`/`.wgsl.ts`, #5384) to rebuild view-space position and normals, then votes an edge at each of 4 (`low`) or 8 (`high`, + diagonals) tap directions on three cues: an entity-id change, a normal crease past 25 degrees, and a depth silhouette measured in linear view-space units (not raw device depth). The average vote across directions is a coverage estimate, so a line antialiases instead of dashing on/off.

- `radius` (tap distance in pixels) is now clamped to 1-3, was 1-2, so `high` quality has room to space its 8 taps.
- `quality`, `intensity` and `enabled` are unchanged.
- The in-shader derivative edge darkening in `main.wgsl.ts` (the `flags.z` block) is left in place: it is a separate, per-fragment effect gated by `edgeContrast`, and this PR keeps that file's changes to zero to stay out of the way of the concurrent specular work there. Follow-up: retire it once the edge pass is confirmed to supersede it visually.
