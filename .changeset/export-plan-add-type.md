---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-export`. An export plan can add a type with no occurrence (`Disposition::AddType`, keyed by the type's own `NewType::global_id`). In IFC4 and IFC4X3 it is declared to the project through `IfcRelDeclares`: all the types a plan adds this way share one relationship, or join the project's existing one when there is one. IFC2X3 has no `IfcRelDeclares`, so there the type is written on its own. A later Add in the same plan can be typed by it through `TypeLink::Existing`. A new type, on its own or created through `TypeLink::New`, now needs a name: `IfcTypeObject` requires one (WR1 in IFC2X3, NameRequired later), and a nameless one was written invalid before.
