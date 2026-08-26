---
"@ifc-lite/ids": patch
---

Fix an IDS property check on an `IfcTimeStamp` property never being able to pass.

The strict XSD-cast gate mapped `IfcTimeStamp` to `xs:duration`, alongside
`IfcDuration`. `IfcTimeStamp` is declared `INTEGER` in every bundled schema — a
UNIX epoch second — so the literal an author has to write (`1609459200`) failed
the ISO-8601 duration pattern and the facet returned `PROPERTY_VALUE_MISMATCH`
whatever the model contained; an actual duration literal (`P1Y2M3D`) passed
where it should not.

It now answers per schema version, matching what the generated attribute table
gives the attribute facet for `IfcOwnerHistory.CreationDate`: `xs:integer`
under IFC2X3, and `xs:integer` / `xs:dateTime` under IFC4 and IFC4X3. A single
union across versions would have replaced the original false-REJECT with a
false-ACCEPT on IFC2X3, where an ISO-8601 date-time literal would pass the
property facet and be rejected by the attribute facet on the same file — the
disagreement the mapping exists to prevent. Callers with no schema version in
hand still get the permissive union.
