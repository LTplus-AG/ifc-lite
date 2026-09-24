---
"@ifc-lite/renderer": minor
---

Give buildings a lit side and a shaded side ([#5382](https://github.com/LTplus-AG/ifc-lite/issues/5382)). The sun and fill lights used `abs(dot(N, L))`, which lit a face turned away from the sun exactly as brightly as one facing it (a slab's underside came out at 0.91 of its top). The default sun also sat behind the default camera, so both walls seen on open were sunlit. With cast shadows on, shadowed areas went near-black because the ambient was about 0.09 of the key light.

The sun and fill are now one-sided, and the fill comes from the side opposite the sun. The default rig is re-balanced:
- sun from `normalize(-0.45, 1, 0.6)`, which lights +Z and leaves +X (seen on open) in shade;
- `sunIntensity` 0.4, `ambientIntensity` 0.775, `skyColor` [0.34, 0.35, 0.36] (near-neutral, so the ambient, now almost half the key, does not tint sunlit whites), `groundColor` [0.24, 0.2, 0.17], `fillIntensity` 0.1, `rimIntensity` 0.05.

A sun-facing horizontal surface stays at unit irradiance (each channel within about 1.5%). Faces turned away from the sun keep about 42% of the key, and a cast-shadowed floor about 48%. Callers passing their own `LightingEnvironment` get the one-sided shading with their values.
