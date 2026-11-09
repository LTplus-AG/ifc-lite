---
"@ifc-lite/renderer": patch
---

Orthographic top and bottom views are now exactly axis-aligned (#9501). The presets used to stop 0.01 rad (about 0.6°) off the pole, which in orthographic projection drew the walls of every vertical member beside its section: a hollow column showed its inner walls and a band along one face. The presets now sit on the pole with the screen orientation carried by `up`, and `setRotation(azimuth, ±90)` does the same instead of clamping. Orbiting from such a pose, including a plan BCF viewpoint or a horizontal section's "Set view", first steps to the orbit range's edge with the same screen orientation; it used to spin the screen by 90 to 180° on the first drag and could not tilt out of the plan. `getRotation` reports the azimuth of an exact bottom view correctly.
