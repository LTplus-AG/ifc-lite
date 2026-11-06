---
"@ifc-lite/renderer": patch
---

Keep small round members in shape under quantized vertices (#9068). The 12-byte vertex layout snaps positions onto a ~1 mm lattice. Ø2 mm rods, railing bars and thin pipes came out as jagged prisms, with most of their triangles collapsed. A batch now stays on the f32 layout when the lattice would collapse more than 1 % of any one entity's surface. Ordinary sub-millimetre slivers keep their batch quantized, and derived batches still inherit their source batch's decision. Scene snapshots move to revision 2, so stale quantized snapshots are rebuilt.
