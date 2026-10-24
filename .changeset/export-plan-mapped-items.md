---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-export`. An export plan's Add can give a new object its type's body instead of geometry of its own (`Representation::Mapped(MappedBody::new(transform))`). It instances the type's `Body` representation maps through `IfcMappedItem`s at a rigid transform. The type can be one in the source, so a copy of an object whose geometry comes from its type keeps that body. It can also be a new type that carries a representation (`NewType::representation` and `NewType::style`), written once as an `IfcRepresentationMap` that every occurrence shares, instead of a copy of the mesh per occurrence. A type added on its own can carry one too.
