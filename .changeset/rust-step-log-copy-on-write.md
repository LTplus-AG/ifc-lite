---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

The Rust mutation-log STEP writer behind `exportStep` now copies a shared property or quantity set on write, as `StepExporter` does since #5794, instead of withholding the set from every element that shares it. The edited element leaves the shared relation and gets its own set that reuses the untouched source members. A type-owned set another type object still names is kept. Both writers also get two fixes. `IfcRelDefinesByProperties` is read so that its OwnerHistory no longer counts as a related object, which had kept an unshared edited set as an orphan. A property whose value is a list is now written as `IfcPropertyListValue` instead of an invalid aggregate in `IfcPropertySingleValue.NominalValue`.
