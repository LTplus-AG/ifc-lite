---
"@ifc-lite/viewer": minor
---

Section picker for beams, columns and members (#6232 D2). The Beam and Column tools' bars get a Section button: rectangle, I / H, angle (L), tee (T), channel (U), lipped channel (C), circle, hollow rectangle and hollow circle, with the dimensions each needs, a preview, and a ghost swept along the beam or up the column as that section. Each element is written as its `IfcXProfileDef` in one undo step; the choice is remembered per beam, member and column. The Model inspector's Profile section changes a placed element's kind or dimensions in one undo step and re-meshes it, and shows the same picker for the defaults of the next element. Splitting a profiled beam keeps its section on both pieces. `addBeam`, `addColumn` and `addMember` on the viewer store accept a `Profile`.
