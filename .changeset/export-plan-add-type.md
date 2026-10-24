---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-export`. An export plan can add a type with no occurrence (`Disposition::AddType`, keyed by the type's own `NewType::global_id`). In IFC4 and IFC4X3 it is declared to the project through `IfcRelDeclares`, one relationship for every type a plan adds this way, extending the project's existing one when there is one. IFC2X3 has no `IfcRelDeclares`, so there the type is written on its own. A later Add in the same plan can be typed by it through `TypeLink::Existing`.
