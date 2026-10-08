---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
---

Scan-to-BIM element proposals (#6894). `IfcAPI.proposeScanElements`, typed as `proposeScanElements` in the new `@ifc-lite/geometry/scan-proposals` entry, turns a scan segmentation report into proposed `IfcWall`, `IfcSlab`, `IfcColumn` and pipe (`IfcPipeSegment`, or `IfcFlowSegment` for IFC2X3) elements in the IFC model frame. Opposite parallel wall faces pair into walls of measured thickness; single faces get a stated default thickness behind their scanned side. Horizontal planes become floors or ceilings, a ceiling and the floor above pair into one slab, and wall and column ends snap to them. A `scanToModel` similarity maps a Y-up, decode-relative or georeferenced scan frame into the model frame. Each proposal carries a confidence, its source detections and their fit statistics.
