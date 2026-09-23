---
"@ifc-lite/renderer": minor
---

Render authored colours as authored ([#5381](https://github.com/LTplus-AG/ifc-lite/issues/5381)). The geometry shader used to multiply sRGB colours by light as if they were linear, then darken near-greys, stretch contrast, boost saturation 1.4x, run ACES and apply a 2.2 power. That turned grass green neon, brown brick crimson and every grey at or below 40/255 pure black, and kept pure white below 202/255.

Colours, overlay tints, texture texels and the selection blue are now decoded to linear before lighting. Highlights roll off with a hue-preserving operator (Khronos PBR Neutral without its toe), and the result is encoded as exact sRGB. The procedural sky uses the same shared functions.

`LightingEnvironment` values keep their meaning and defaults. A fixed calibration converts them to linear irradiance so the default rig lights a sun-facing surface at exactly its authored colour, and every preset keeps its relative brightness. The rendered look of every model changes.
