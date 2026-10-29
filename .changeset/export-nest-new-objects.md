---
"@ifc-lite/wasm": patch
---

Rust-only: in `ifc-lite-export`, a new object in an export plan can name the product it is nested in through `NewObject::nest_in` (or `with_nest_in`), such as a pipe for its port. The host can be in the source or added earlier in the same plan. IFC4 and IFC4X3 write `IfcRelNests`, extending the host's existing one when it has one. IFC2X3 connects a port to its element through `IfcRelConnectsPortToElement` and nests anything else only under a product of its own class, as its `IfcRelNests` rule requires. With no `relative_to`, a nested object is placed relative to its host. A host that is missing, deleted, not a product, or not allowed by the schema refuses the object, as does nesting a new spatial structure element, which is aggregated into its container.
