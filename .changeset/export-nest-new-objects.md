---
"@ifc-lite/wasm": minor
---

Rust-only: in `ifc-lite-export`, a new object in an export plan can name the product it is nested in through `NewObject::nest_in` (or `with_nest_in`), such as a pipe for its port. The host can be in the source or added earlier in the same plan. IFC4 and IFC4X3 write `IfcRelNests`, extending the host's existing one when it has one. IFC2X3 connects a port to its element through `IfcRelConnectsPortToElement` and nests anything else only under a product of its own class, as its `IfcRelNests` rule requires. With no `relative_to`, a nested object is placed relative to its host, and it takes no container of its own. These refuse the object: a host that is missing, deleted, not a product, or not allowed by the schema; a port whose host is not an element; a nested object with a container; and a new spatial structure element, which is aggregated into its container.
