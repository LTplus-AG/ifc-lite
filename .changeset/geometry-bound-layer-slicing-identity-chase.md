---
'@ifc-lite/geometry': patch
---

Layer slicing no longer aborts the process on a self-referential
`IfcBooleanResult`. `item_has_identity_position` chased
`IfcBooleanResult.FirstOperand` recursively, and that reference comes from the
file, so a single entity referring to itself
(`#10=IFCBOOLEANRESULT(.DIFFERENCE.,#10,#20)`) overflowed the stack. A Rust
stack overflow aborts the process rather than raising a catchable panic, so no
caller could turn it into a load error — the whole load died on raw uploaded
bytes.

The chase is now an iterative walk with a visited set that stops at the first
repeated node. There is deliberately no length cap: Revit exports chains up to
42 `DIFFERENCE` nodes deep, and a cap would drop layer slicing on files that
render correctly today.

Note what happens at the guard, because nothing catchable surfaces. On a
repeat the probe returns `false`, so `element_is_single_unshifted_item` returns
`false` and the element renders as a single un-sliced mesh with one material
instead of per-layer sub-meshes. That is a visible loss of layer materials for
the offending element, reported nowhere; the rest of the file loads normally.
