---
"@ifc-lite/drawing-2d": patch
---

`exportToSVG` defines a `<pattern>` for every hatch type a cut can be filled with. A cut `IfcRoof` filled with `url(#hatch-cross-hatch)` while the defs only carried `hatch-cross`, and `vertical`, `brick`, `insulation`, `earth` and `wood` had no definition at all, so those fills silently rendered empty.
