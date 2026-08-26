---
"@ifc-lite/export": patch
---

Schema conversion trims an attribute list whenever the target schema is strictly shorter, in either direction. The trim was gated on schema rank rather than on the attribute-name prefix relation, so the 10 entities IFC4 shortened relative to IFC2X3 (and the 4 IFC4X3 shortened relative to IFC4) kept their extra trailing arguments in a file whose header declares the newer schema.
