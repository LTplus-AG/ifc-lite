---
"@ifc-lite/renderer": patch
---

Split `section-2d-overlay.ts` (1176 lines) along the resource/description seam.

The WGSL for both pipelines moves to `shaders/section-2d-overlay.wgsl.ts`, the 2D→3D lift and cap triangulation to `section-2d-lift.ts`, and the per-family vertex buffer to a `WorldLineBuffer` value object in `section-2d-line-buffer.ts`. None of those own a shared GPU resource: the two pipelines, the bind-group layout, the bind group and the single 160-byte uniform buffer stay owned by `Section2DOverlayRenderer` and are passed to a draw rather than held. The public API is unchanged.

Also fixes a GPU buffer leak the split surfaced: `Section2DOverlayRenderer.dispose()` did not release the clash-overlap-box vertex buffer (#1277 added the sixth line family and never wired it into disposal), leaking it on every renderer teardown.
