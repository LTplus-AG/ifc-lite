---
"@ifc-lite/wasm": patch
---

Make the world geometry hash invariant to `IfcRelVoidsElement` statement order (#2019).

Each host's opening list was accumulated in file order (and extended in hashmap-iteration order during aggregate propagation), then subtracted sequentially by the void CSG kernel. Sequential cuts are not associative — every pass snaps f64 to f32 — so two exports of the same design that differ only in the order of their `IFCRELVOIDSELEMENT` statements produced numerically different, geometrically equivalent meshes, and therefore different world geometry hashes for walls, wall standard cases and coverings.

Since that hash is the "did this element's shape or position change" signal, a re-export that merely reordered statements reported a false *changed* in Compare. Opening lists are now sorted by express id before the cut.

What this buys, precisely: the hash is stable under any reordering that preserves express ids — which is what #2019 measured — and under a monotone renumber such as a merge offset, since neither changes the openings' relative order. It is **not** stable under an arbitrary id permutation: if a re-export renumbers two openings so their relative order flips, the sorted sequence changes and the hash moves with it. Express ids are themselves a property of the byte layout, so this narrows the dependency rather than removing it. Surviving a cross-tool re-export needs an id-independent canonical key — opening GlobalId, or a geometric key — which is worth its own issue.

Note for consumers treating the hash as a stable content address: elements whose `IFCRELVOIDSELEMENT` statements were not already in ascending express-id order hash differently once, after which the value is stable under the reorderings above. Measured against the committed corpus that is 283 of 5,577 voided hosts, roughly 5%.
