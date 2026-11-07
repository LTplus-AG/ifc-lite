---
'@ifc-lite/viewer': minor
---

Gaussian splat captures (Gaussian PLY and `.splat`) now open in the production viewer by default (#8568). Pickers and drop offer `.splat`; a Gaussian `.ply` is still told apart from a point-cloud `.ply` by content. Published limits are checked before decoding, with a translated message: 500 MB per capture, 1,000,000 splats per scene, spherical-harmonics degree 3, and a WebGPU device. The capture panel and the new user guide disclose the limitations: approximate composition with glass/X-ray, clipping by Gaussian centre, uncalibrated captures, no picking, measurement or snapping, and no export (export dialogs now say so and never offer a capture as a source). Building with `VITE_GAUSSIAN_SPLATS=disabled` is the kill switch. Content-free diagnostics report load outcomes and device loss/recovery counts.
