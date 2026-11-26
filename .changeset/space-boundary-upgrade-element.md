---
"@ifc-lite/export": patch
---

An IFC2X3 to IFC4 or IFC4X3 export no longer writes an IfcRelSpaceBoundary that names no RelatedBuildingElement, which IFC2X3 allowed to be unset (the usual VIRTUAL boundary) and IFC4 requires, with an IfcVirtualElement behind a VIRTUAL one. The converter invents no element, so the boundary is left out, counted in the export warnings and listed in the conversion loss report; a boundary that names an element is unchanged. Records that name a left-out boundary drop the reference. A boundary edited in the same export is still written by the single-model exporters; the merged exporter leaves it out too.
