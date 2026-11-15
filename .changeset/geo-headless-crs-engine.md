---
"@ifc-lite/geo": minor
"@ifc-lite/viewer": patch
---

New package `@ifc-lite/geo`: the CRS engine the viewer places models on a map with, now usable from Node. `resolveCrs({ epsg, name, wkt })` returns a transformer that converts points to and from WGS84 and reads grid convergence and point scale factor; `egm96Undulation` gives the EGM96 geoid height. The package makes no network request by itself: the epsg.io lookup and the cdn.proj.org datum grids are loaders the host installs with `configureCrsLoaders`. The viewer installs both and behaves as before.
