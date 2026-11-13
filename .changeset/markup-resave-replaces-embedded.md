---
"@ifc-lite/viewer": patch
---

Saving 2D drawing markup into a model no longer duplicates markup the file already carried. When a model saved with markup was reopened and its markup restored, "Save markup to model" added a second copy of every annotation. The save now replaces all IfcLite markup annotations in the model, including those from the file, and removes their representation, placement, property and quantity sets and relationships. Geometry other elements share and annotations from other tools are kept. Saving with no markup left removes the embedded markup, as it already did for markup saved in the same session.
