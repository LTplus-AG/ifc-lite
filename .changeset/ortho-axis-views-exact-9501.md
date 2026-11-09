---
"@ifc-lite/renderer": patch
"@ifc-lite/viewer": patch
---

Orthographic top and bottom views are now exactly axis-aligned (#9501). The presets used to stop 0.01 rad (about 0.6°) off the pole, which in orthographic projection drew the walls of every vertical member beside its section: a hollow column showed its inner walls and a band along one face. The presets now sit on the pole with the screen orientation carried by `up`, and `setRotation(azimuth, ±90)` does the same instead of clamping.

Navigation from such a pose keeps the screen orientation:
- Orbiting first steps to the orbit range's edge. Before, orbiting off a plan BCF viewpoint or a horizontal section's "Set view" spun the screen by 90 to 180° on the first drag and could not tilt out of the plan.
- Fly look, Walk look, Walk spawn and first-person moves take their heading from screen-up and level `up` to world Y.
- Rotate left/right turns a plan.
- An SDK `setCamera` without `up` no longer carries a plan's horizontal up into a side view.
- `getRotation` keeps the azimuth steady below the horizon, so the ViewCube no longer flips 180° at the end of a tween into the bottom view.
