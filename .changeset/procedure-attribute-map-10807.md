---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Schema conversion between IFC2X3 and IFC4/IFC4X3 writes IfcProcedure, IfcObjective and IfcDocumentInformation in the target's layout (#10807). Their attribute lists have the same length in both schemas, so they passed through by position: an IFC2X3 `ProcedureType` landed in IFC4's `LongDescription`. Each now has a reviewed attribute map (`ProcedureType` -> `PredefinedType`, `DocumentId` -> `Identification`, an IfcMetric `BenchmarkValues` wrapped into IFC4's list); values with no target slot are reported dropped.
