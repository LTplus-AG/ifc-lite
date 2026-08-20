---
"@ifc-lite/renderer": minor
---

Add sun-cast shadows to the standalone WebGPU viewer (#2670, Phase 2).

The standalone path had no cast shadows — surfaces were lit as if nothing
occluded them, reading flat next to a tool like Blender. This adds classic sun
shadow mapping end to end:

- a depth pre-pass (`ShadowPass`) renders every occluder from the sun into a
  shadow map, fitted with an orthographic light-view-projection
  (`fitSunLightMatrix`) whose lateral extent tracks the camera frustum clipped
  to the model (`cameraFrustumFocusCorners`) while the depth range spans the
  whole model, so a small building on a large site keeps sharp shadows instead
  of spending the whole map on distant terrain;
- the shared main-family fragment shader samples it with a rotated 12-tap
  Poisson-disk PCF kernel and a slope-scaled bias (normal-offset plus a
  grazing-angle depth term, so a flat ground under a low sun does not ring with
  acne), occluding only the direct sun term — ambient/fill/rim stay lit;
- the penumbra width follows the sun's angular size (physical, ~0.53° like
  Blender's Sun lamp Angle), exposed as `sunShadows.sunAngleDeg`.

All four geometry paths — flat, lattice-quantized, GPU-instanced and
surface-textured — both cast (`collectShadowOccluders`) and receive (the shared
shader / textured derivation), so no part of the model silently stops
shadowing; a test drives the real `ShadowPass.render` and asserts each path
issues a depth draw through its own pipeline. Transparent geometry (glass
windows, and the virtual IfcSpace / IfcOpeningElement volumes) is excluded from
casting by its material alpha, so daylight passes through windows and openings
instead of the glass throwing a solid shadow into the void the wall already
carries.

The shadow map rides the existing environment bind group (group 1), so no
pipeline-layout churn. Additive and off by default: `RenderOptions.sunShadows`
(`{ enabled, resolution?, sunAngleDeg? }`) — absent/`enabled: false` skips the
pass entirely and the shader's `enabled` gate returns fully lit, so the hot
path pays only a boolean check. The viewer drives it from a Sun & Sky panel
section (cast-shadows toggle, sun-angle softness, resolution, and a manual
time-of-day sun for models without georeference).

