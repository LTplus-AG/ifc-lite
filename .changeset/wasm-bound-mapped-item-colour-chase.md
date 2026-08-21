---
'@ifc-lite/wasm': patch
---

The viewer's colour resolver no longer aborts the worker on a cyclic mapped
item. `find_color_for_geometry` chased `IfcMappedItem ->
IfcRepresentationMap -> MappedRepresentation.Items` with no depth cap and no
visited set, and a three-entity file whose mapped representation lists the
mapped item itself was enough to overflow the stack. The resolver runs while
the browser batches GPU meshes, for every element with a representation in any
file that carries geometry styles, and a Rust stack overflow aborts rather than
raising a catchable panic, so the tab's worker died with no error to report.

The chase is bounded in both dimensions, because a depth cap alone only trades
the abort for a hang — `k` items each leading back into the cycle cost
`O(k^depth)` decodes. It now stops at 32 hops — the same cap the
mapped-item traversals in `ifc-lite-geometry`'s `router::processing` and
`ifc-lite-processing`'s `element` use, which #2873 has since consolidated into
one `MAX_MAPPED_ITEM_DEPTH` in `ifc-lite-core` that all three now import — and
records the depth each item was explored at, so a cycle is broken while an item legitimately reached again from
a shorter branch is still resolved — a plain visited set silently lost that
item's authored colour.

Nothing catchable surfaces at the bound: the resolver returns `None`, so the
element renders in its fallback colour instead of its authored one. Geometry is
unaffected — the router builds the mesh regardless — and the rest of the file
resolves normally.
