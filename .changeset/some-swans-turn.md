---
"@ifc-lite/export": minor
---

Include the effective owning IfcGrid when serializing grid-relative remesh subgraphs, preserving physical placement in IFC2X3, IFC4 and IFC4X3. Report deleted, ambiguous or invalid axis ownership through the existing unreadable result instead of inventing a frame.

Add gridPlacementDependents to query live grid ownership and local-child placement dependencies from the same effective records used for export. The stacked viewer layer consumes this shared dependency query for native remeshing.
