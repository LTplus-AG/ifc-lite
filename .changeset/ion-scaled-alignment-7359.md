---
"@ifc-lite/wasm": patch
---

Cesium ion compatibility export now supports alignment models when the map has a uniform scale other than one (for example the UTM 0.9996). `IfcAlignment`, `IfcAnnotation` and `IfcLinearPlacement` no longer refuse on this path. Each product's fresh root frame is composed through its linear placements, which are resolved strictly (an unresolvable one refuses instead of falling back to identity). Curve-only representations such as `Axis` and `FootPrint` are carried through the same scaled mapped wrapper as Body geometry. Other non-Body representations, and type geometry that no occurrence instantiates, still refuse with a listed reason.
