---
"@ifc-lite/viewer": patch
---

The world (Cesium) view no longer opens on a pitch-black background: the sky/atmosphere is on by default there now, while the standalone WebGPU viewport's lighting presets are unaffected. A previously saved choice — on or off — still wins over this default. The Sun & Sky panel's world-context toggle is relabelled "Sky" (was "Atmosphere"), and its tooltip now notes that it also drives lighting.
