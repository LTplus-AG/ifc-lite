---
"@ifc-lite/renderer": minor
---

Stop distorting authored colours ([#5381](https://github.com/LTplus-AG/ifc-lite/issues/5381)). The geometry shader used to multiply sRGB colours by light as if they were linear, then darken near-greys, stretch contrast, boost saturation 1.4x, run ACES and apply a 2.2 power. That turned grass green neon, brown brick crimson and every grey at or below 40/255 pure black, and kept pure white below 202/255.

Colours, overlay tints, texture texels and the selection blue are now decoded to linear before lighting. Highlights roll off with a hue-preserving operator (Khronos PBR Neutral without its toe), and the result is encoded as exact sRGB. The procedural sky uses the same shared functions.

`LightingEnvironment` values keep their meaning and defaults. A fixed calibration converts them to linear irradiance, so the default rig lights a sun-facing horizontal surface at unit irradiance by luma, and every preset keeps its relative brightness. Mid-tone colours on that surface render within about 2% of their authored values per channel (the residual comes from the default sky tint). Colours brighter than about 227/255 roll off with their hue preserved, so pure white lands near 241/255. The rendered look of every model changes.
