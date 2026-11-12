---
"@ifc-lite/parser": minor
"@ifc-lite/wasm": patch
"@ifc-lite/viewer": minor
---

Structural analysis models draw more of what the file states (#9668). Reactions draw as glyphs in their own colour (`reaction: true` on the glyph). IFC2X3 varying linear actions draw their `SubsequentAppliedLoads`, interpolated along the member. A point action with only a placement draws where that placement puts it on its curve or surface item. An `IfcRelConnectsStructuralActivity` written with its two ends swapped is read as the same link. The mesh pipeline now draws structural members whose topology type is `'Undefined'`, IFC2X3 members held in a bare `IfcProductRepresentation`, bare `IfcFace` surfaces, faces on an `IfcCurveBoundedPlane`, and faces made of several outer bounds (AxisVM).
