---
"@ifc-lite/create": patch
---

Derive reads `IfcAsymmetricIShapeProfileDef` sections (#10377). Their bounds are the wider flange by the overall depth, and the member is idealised through the section's centroid, not the middle of the bounds. The bottom flange is taken at the bottom because the viewer's profile reader draws it there; no authoring file states it. An omitted TopFlangeThickness is the bottom flange's. A profile the geometry reader refuses (a missing or non-positive width, thickness or web, or a depth under the two flange thicknesses) is refused with its own reason instead of being read as symmetric. Before, derive refused every such profile as unsupported.
