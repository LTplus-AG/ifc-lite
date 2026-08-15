---
"@ifc-lite/drawing-2d": patch
---

Fix `EdgeExtractor` reading mesh positions as if they were already world space. Positions are stored in the element's local frame (`world = origin + local`) on the wasm client path; `section-cutter.ts`, `storey-bands.ts`, and `gpu-section-cutter.ts` already lift by `mesh.origin`, but `edge-extractor.ts` did not, so crease/boundary/silhouette edges from an origin-shifted mesh were extracted in the wrong place and compared against the world-space section plane and bands incorrectly — landing in the wrong depth band or projecting far from the correctly-placed cut polygons. `getVertex` now lifts by `mesh.origin` when present, matching `section-cutter.ts`. Meshes with no origin (or `[0,0,0]`) are unaffected.

Also fix `HiddenLineClassifier` (`hidden-line.ts`), which the `EdgeExtractor` change above left inconsistent: it still rasterized its occlusion depth buffer from raw local-frame positions while `drawing-generator.ts` now feeds it world-space lines from the fixed `EdgeExtractor`. With projection and "show hidden lines" both enabled and a non-zero `mesh.origin`, this silently turned hidden-line removal into a no-op. `hidden-line.ts`'s `getVertex` now lifts by `mesh.origin` too, at both the bounds-computation and rasterization call sites.
