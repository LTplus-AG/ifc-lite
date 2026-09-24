---
"@ifc-lite/viewer": patch
---

Opening-fit follow-up (#5633): a small object close to the model (a lamp post, a shrub, a shed) now stays in the Home / Fit All framing; only coordination-marker proxies (`IfcBuildingElementProxy`) or objects at least one model length away are left out. The early fit during streaming no longer frames a subset of a first batch under 8 meshes, and a stray far-away point no longer hides a marker from the framing check.
