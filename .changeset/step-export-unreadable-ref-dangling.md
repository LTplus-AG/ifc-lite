---
"@ifc-lite/export": patch
---

Fix a STEP export that could emit a relationship referencing an entity it never wrote. On a plain full export — no `visibleOnly`, no deletions, no overlay — an entity whose source byte range the buffer cannot serve is skipped by the source-iteration pass, but an `IfcRelContainedInSpatialStructure` (or any `IFCREL*`) naming it was still copied out verbatim, leaving a `#N` with no `#N=` line. Strict viewers reject such a file; lenient ones fall the geometry back to the origin.

The cause was two predicates for one question. `willBeEmitted` recognises seven reasons a line never lands in the file, while the relationship-reference filter consumed a separate predicate that answered for three of them (hidden product, tombstoned, never existed) — and a second gate in front of the filter suppressed it entirely unless hidden products or an overlay were present. Both relationship-emission passes now filter on the negation of `willBeEmitted` itself, and that gate is gone, so the filter and the emission answer the same question by construction. This additionally covers references to entities dropped by the visible-only closure or by `includeGeometry: false`, which the old predicate also missed.

The closure walk deliberately keeps its own predicate: `willBeEmitted` reads the very id set that walk produces, so using it there is circular.

Also corrects the stated reason `source-ref-bounds.ts` exempts its incidental readers (`getPropertySetName` and siblings). The old wording claimed a clamped decode is empty and so yields no match; a negative offset carrying a real length instead decodes the *wrong* record and returns a confidently wrong name. The exemption is still safe, but because no such ref exists — the only negative offset in the repo is always paired with a zero length and never enters the parsed entity index — and that is now what the doc says, with both facts pinned by tests.
