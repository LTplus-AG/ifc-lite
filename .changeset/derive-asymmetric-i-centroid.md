---
"@ifc-lite/create": patch
---

Derive reads `IfcAsymmetricIShapeProfileDef` sections (#10377). Their bounds are the wider flange by the overall depth, and the member is idealised through the section's centroid, not the middle of the bounds, with the bottom flange at the bottom as the geometry reader draws it. An omitted TopFlangeThickness is the bottom flange's. Before, derive refused these profiles as unsupported.
