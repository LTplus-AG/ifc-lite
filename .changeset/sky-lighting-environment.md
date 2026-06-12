---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

Sky and lighting options for both rendering paths.

Renderer: the hardcoded shader lights move into a global lighting-environment
uniform (group(1)) — sun direction/colour/intensity, hemisphere ambient,
exposure — with defaults that render pixel-identical to the previous look,
plus a procedural sky pass (analytic gradient + sun disc, drawn at the
reverse-Z far plane, tonemapped with the same ACES curve as geometry).

Viewer: an Environment panel with lighting presets (Default, Day, Overcast,
Evening, Night), a Sky toggle and an exposure trim; in geo mode the same Sky
toggle drives Cesium's atmosphere, sun and fog instead of the WebGPU sky.
The sun-path study now also lights the model directly: the NOAA sun position
at the site is mapped into viewer space (inverse of the Cesium bridge's
ENU frame) with golden-hour/twilight/night photometric fades, so daylight
studies read identically with and without the 3D world context.
