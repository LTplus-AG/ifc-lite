---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-export`. An export plan's Add can give a new product the same geometry as a product already in the source with `Representation::SameAs(source)`. The new product gets its own `IfcProductDefinitionShape` and one representation per representation of the source, in the same context with the same identifier and type, listing the source's own items. Nothing is copied, so a swept solid stays a swept solid, a mapped body stays mapped, and the source's styles apply to both. This works in IFC2X3, IFC4 and IFC4X3. The Add is refused when the source is not found, is not a product, has no representation, is deleted by the same plan, is added by the same plan, or has a representation in a context or with items the plan deletes. A colour on a reused body is refused too, since the body keeps the source's colour. Plans that do not use it write the same bytes as before.
