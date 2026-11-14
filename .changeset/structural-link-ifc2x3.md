---
"@ifc-lite/export": patch
---

Converting IFC4 to IFC2X3 now writes an IfcRelAssignsToProduct that links one structural member to its physical element as IfcRelConnectsStructuralElement, IFC2X3's physical-to-analytical link, and reports it as a structural conversion warning. This applies to any IFC4 source in an unedited full export, so the link from an IFC2X3 model round trips through IFC4.
