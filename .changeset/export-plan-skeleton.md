---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-export`. An export plan can start from nothing: `plan::skeleton` writes a new IFC4 file holding a project (SI units), a model context with a `Body` subcontext, a site and a building, and optionally an `IfcMapConversion` to a named `IfcProjectedCRS` and a true north. A plan of Adds runs against it like any other source. An Add can give a new type its own GlobalId (`NewType::global_id`), and places the opening it cuts at a matrix in its own frame (`NewOpening::matrix`).
