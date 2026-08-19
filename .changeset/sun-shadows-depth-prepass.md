---
"@ifc-lite/renderer": minor
---

Add sun cast shadows to the standalone WebGPU viewer (#2670, Phase 2).

The standalone path had no cast shadows — surfaces were lit as if nothing
occluded them, reading flat next to a tool like Blender. This adds classic sun
shadow mapping end to end:

- a depth pre-pass (`ShadowPass`) renders every occluder from the sun into a
  shadow map, fitted with an orthographic light-view-projection
  (`fitSunLightMatrix`) sized to the model bounds (a single well-conditioned
  cascade; view-frustum fitting for site-scale models is a documented
  follow-up);
- the shared main-family fragment shader samples it with a 3×3 PCF kernel and a
  **normal-offset bias** (reusing the face normal, so no acne/peter-panning
  trade), occluding only the direct sun term — ambient/fill/rim stay lit;
- the penumbra width follows the sun's angular size (physical, ~0.53° like
  Blender's Sun lamp Angle), exposed as `sunShadows.sunAngleDeg`.

All four geometry paths — flat, lattice-quantized, GPU-instanced and
surface-textured — both cast (`collectShadowOccluders`) and receive (the shared
shader / textured derivation), so no part of the model silently stops
shadowing; a test drives the real `ShadowPass.render` and asserts each path
issues a depth draw through its own pipeline.

The shadow map rides the existing environment bind group (group 1), so no
pipeline-layout churn. Additive and off by default: `RenderOptions.sunShadows`
(`{ enabled, resolution?, sunAngleDeg? }`) — absent/`enabled: false` skips the
pass entirely and the shader's `enabled` gate returns fully lit, so the hot
path pays only a boolean check. A Sun & Sky UI panel and the end-to-end perf
verdict are still to come.

