---
'@ifc-lite/viewer': patch
---

Add the missing `'malformed-operand'` member to `ClashSolidDegenerateReason`.

The wasm binding `clashIntersectionSolid` returns five degenerate reason
strings, but the viewer's union declared only four. `'malformed-operand'` — the
binding's own verdict when an operand has a positions/indices length that is not
a multiple of 3, an index past its own operand's vertex count, or a non-finite
coordinate — was absent. The union's doc comment said it mirrored
`DegenerateReason` in `clash_solid.rs`, and it did: that reason is produced by
the binding's `mesh_from` guard and has no enum variant behind it, so mirroring
the enum missed it. Because the reason crosses the wasm boundary as an untyped
string and is cast on arrival, TypeScript could not catch the gap.

No UI copy changes: the clash panel's reason chain already ends in a generic
"No solid could be computed for this pair" fallback, which is accurate for a
rejected operand, and every consumer of the union either handles the reason
positionally or falls through to that string. The defect was that the type
claimed a value the runtime can produce is impossible, so any future
exhaustiveness check over it would have been built on a set that is short by one.

A new test pins the union against `clash_solid.rs` itself, comparing the two
sets in both directions, so adding a reason on either side without the other now
fails; a second test confirms through the real wasm kernel that a
malformed operand does come back as `'malformed-operand'`.
