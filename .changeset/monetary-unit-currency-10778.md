---
"@ifc-lite/export": patch
"@ifc-lite/wasm": patch
---

Schema conversion writes `IfcMonetaryUnit.Currency` in the target's type (#10778). IFC2X3 declares it an `IfcCurrencyEnum` (`.EUR.`), IFC4 and IFC4X3 an `IfcLabel` (`'EUR'`), and the value used to pass through unchanged, invalid in either direction. IFC5 is treated as IFC4X3. An upgrade writes the member as a label; a downgrade writes a label that names an IFC2X3 member as that member and anything else as `$`, which the IFC2X3 required-slot warning reports and the Rust exporter counts as dropped.
