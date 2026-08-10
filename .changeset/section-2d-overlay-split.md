---
"@ifc-lite/renderer": patch
---

Split `section-2d-overlay.ts` (1176 lines) along the resource/description seam.

The WGSL for both pipelines moves to `shaders/section-2d-overlay.wgsl.ts`, the 2D→3D lift and cap triangulation to `section-2d-lift.ts`, and the per-family vertex buffer to a `WorldLineBuffer` value object in `section-2d-line-buffer.ts`. None of those own a shared GPU resource: the two pipelines, the bind-group layout, the bind group and the uniform buffer stay owned by `Section2DOverlayRenderer` and are passed to a draw rather than held. The public API is unchanged.

Also fixes three defects the split surfaced, all pre-existing:

- **Every overlay draw in a frame shared one uniform record.** The cut cap and the five world-space line families are encoded into one render pass, and each wrote byte 0 of the same 160-byte buffer. `queue.writeBuffer` is a queue operation applied before the command buffer executes, so the last write won and every draw read it: the clash-overlap box's colour bled onto the annotation, alignment, grid and DXF overlays, and the cut cap lost its fill colour and hatch to the zeroed cap-style tail a line draw writes. Each draw site now owns a slot in the buffer, addressed by a dynamic bind-group offset sized to the device's `minUniformBufferOffsetAlignment`.
- **A line-list array that was not a whole number of segments produced a fractional vertex count**, which is a WebGPU validation error that fails the whole command buffer — taking every other overlay in the pass with it. Uploads now truncate to complete segments.
- **`Section2DOverlayRenderer.dispose()` did not release the clash-overlap-box vertex buffer** (#1277 added the sixth line family and never wired it into disposal), leaking it on every renderer teardown.

The brick hatch's band parity uses a signed comparison, so it stays correct if the pattern is ever evaluated at a negative coordinate.
