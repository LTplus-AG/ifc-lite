---
"@ifc-lite/export": minor
---

`StepExportOptions.guidRandom` seeds the GlobalIds `StepExporter` synthesizes at export time - the `IfcPropertySet` / `IfcElementQuantity` roots it regenerates for mutated or overlay-created property and quantity sets, their `IfcRelDefinesByProperties` links, and any `IFCPROXY` placeholder minted by schema conversion (`convertStepLine` gained a matching optional `random` argument). Without it those four roots came from the platform CSPRNG, so a seeded in-store build that used `addPropertySet` / `addQuantitySet` still exported different bytes on every run. `StepExportOptions.timeStamp` additionally pins the STEP header `FILE_NAME` instant, so a fully seeded export is byte-identical run to run. Both are optional; omitting them keeps the previous random / wall-clock behaviour exactly.
