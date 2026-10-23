---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-export`. An export plan's Add can give the new object a material (`NewObject::material`: an existing material record, a new `IfcMaterial`, or a new layer set) and classification references (`NewObject::classifications`: an existing reference, or a new one into an existing or new `IfcClassification`), and a property or quantity value can carry its own unit (`NewProperty::unit`: an existing unit record or a new `IfcSIUnit`). A copy that names its source's records reuses them and joins the source's `IfcRelAssociatesMaterial` or `IfcRelAssociatesClassification`. New records described the same way by several Adds are written once. A unit that does not measure its value's measure type is refused.
