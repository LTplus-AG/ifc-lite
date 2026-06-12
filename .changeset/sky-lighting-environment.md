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

Viewer: one collapsible, mode-aware Sun & Sky panel. Standalone it offers
lighting presets (Default, Day, Overcast, Evening, Night), a Sky toggle and
an exposure trim; in the Cesium world context the model is lit by the sun
and atmosphere, so the panel swaps presets for the Sky/atmosphere toggle and
the sun-path study. The study now also lights the model directly: the NOAA
sun position at the site is mapped into viewer space (inverse of the Cesium
bridge's ENU frame) with golden-hour/twilight/night photometric fades, so
daylight studies read identically with and without the 3D world context.

Cesium: OSM Buildings mode keeps the globe with the satellite base map —
buildings sit on top of the imagery instead of replacing it, and the globe
receives the buildings' and model's cast shadows during a sun study.
