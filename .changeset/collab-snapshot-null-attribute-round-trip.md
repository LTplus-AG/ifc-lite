---
'@ifc-lite/collab': patch
---

Fix `snapshotToIfcx` writing a literal `null` for a flat attribute value that its own counterpart, `seedFromIfcx`, treats as an IFCX removal opinion and silently drops.

A doc attribute can legitimately hold `null` (e.g. a user clearing a root
attribute like `Description` through the viewer's mutation bridge). Before
this fix, `snapshotToIfcx` serialized that value verbatim, so a
snapshot -> seed -> snapshot cycle was not idempotent: the first snapshot
carried `"Description": null`, the intervening seed dropped the key per
`from-ifcx.ts`'s documented contract, and the second snapshot of the
re-seeded doc omitted the key entirely - two snapshots of "the same" doc
state disagreeing with each other.

`snapshotToIfcx` now drops null-valued attributes on the way out, matching
the reader's contract instead of handing it a value it is guaranteed to
discard on the next round-trip.
