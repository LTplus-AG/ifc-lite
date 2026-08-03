---
"@ifc-lite/wasm": patch
---

Make the world geometry hash invariant to `IfcRelVoidsElement` statement order (#2019).

Each host's opening list was accumulated in file order (and extended in hashmap-iteration order during aggregate propagation), then subtracted sequentially by the void CSG kernel. Sequential cuts are not associative — every pass snaps f64 to f32 — so two exports of the same design that differ only in the order of their `IFCRELVOIDSELEMENT` statements produced numerically different, geometrically equivalent meshes, and therefore different world geometry hashes for walls, wall standard cases and coverings.

Since that hash is the "did this element's shape or position change" signal, a re-export that merely reordered statements reported a false *changed* in Compare. Opening lists are now sorted by express id, so the accumulation order is a property of the model rather than of the byte layout.

Note for consumers treating the hash as a stable content address: elements whose `IFCRELVOIDSELEMENT` statements were not already in ascending express-id order will hash differently once, after which the value is order-stable.
