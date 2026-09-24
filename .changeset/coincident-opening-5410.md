---
"@ifc-lite/wasm": patch
---

Walls whose body already contains their window voids no longer lose geometry when their openings cut the same voids again (#5410). Revit exports voided walls as extrusions of a profile with holes and adds an `IfcOpeningElement` per window; faces disappeared, and wall above, below and between the windows was cut away. Extrusions with profile holes, including tapered extrusions and partial-depth voids, are now wound consistently, so the openings leave the wall at its authored volume. Plan-rotated walls whose openings are tessellated or boundary-represented solids without an extrusion direction are now cut in the wall's own frame.
