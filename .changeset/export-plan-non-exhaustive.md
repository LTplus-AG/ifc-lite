---
"@ifc-lite/wasm": major
---

Rust only, in `ifc-lite-export`; nothing in the wasm package changes. The export plan's public structs and enums (`plan::NewObject`, `NewType`, `Extrusion`, `Patch`, `PropWrite`, `ExportPlan`, `Disposition`, `Representation`, the material and classification types, `Skeleton` and the rest) are now `#[non_exhaustive]`, so a field or variant added later is not a breaking change. Outside the crate, build a struct with its `new` constructor and finish it with the `with_*` setters or by assigning its public fields (`NewObject::new(id, IfcClass::Wall, NewPlacement::new(plan::IDENTITY)).with_container(storey)`); match the enums with a wildcard arm. `PropScope`, `PsetKind` and `GlobalId` are unchanged. Output is byte-identical.
