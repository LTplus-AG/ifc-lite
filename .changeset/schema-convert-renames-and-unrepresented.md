---
'@ifc-lite/export': patch
'@ifc-lite/parser': patch
---

Schema conversion now treats attributes a schema renamed in place (`IfcStairFlight.NumberOfRiser(s)`, `ItemReference` to `Identification` on the classification, document and library references, `IfcPermit`, `IfcActionRequest`, `IfcProjectOrder`, `IfcCostValue`, the work plan and schedule types, the IFC4X3 `Specification` rename) as the same slot, so they are padded or trimmed to the target arity instead of keeping the source arity. The twin Rust converter (the CLI, wasm and Python `export` path) refuses an IFC4X3-only resource record on an IFC4 target, as this package already did, instead of writing it under its IFC4X3 name into an IFC4 file. `detectSchemaVersion` folds a `FILE_SCHEMA` identifier by ASCII only, like the Rust detector.
