---
"@ifc-lite/geometry": patch
---

Docs-only: refresh the package description and README performance claim. The old "1.9x faster than web-ifc" figure predates both web-ifc 0.0.77 (which substantially improved its geometry speed) and ifc-lite's exact-arithmetic CSG kernel; the package now describes what is actually differentiating - exact boolean cuts verified element-by-element against IfcOpenShell.
