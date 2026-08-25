---
"@ifc-lite/ids": patch
---

Fix an IDS property check on an `IfcTimeStamp` property never being able to pass.

The strict XSD-cast gate mapped `IfcTimeStamp` to `xs:duration`, alongside
`IfcDuration`. `IfcTimeStamp` is declared `INTEGER` in every bundled schema — a
UNIX epoch second — so the literal an author has to write (`1609459200`) failed
the ISO-8601 duration pattern and the facet returned `PROPERTY_VALUE_MISMATCH`
whatever the model contained; an actual duration literal (`P1Y2M3D`) passed
where it should not. It now maps to `xs:integer` / `xs:dateTime`, the same
answer the generated attribute table gives the attribute facet for
`IfcOwnerHistory.CreationDate` and `.LastModifiedDate`.
