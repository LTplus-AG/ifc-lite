---
'@ifc-lite/collab': patch
---

Fix `mergeBranch(parent, branch, 'layer')` silently dropping every edit the branch made to an entity that already existed in the parent.

The `'layer'` strategy snapshotted the branch as IFCX and fed the result to
`seedFromIfcx`. That seeder routes every node through `createEntity`, which
is a deliberate no-op on a path the doc already holds — right for seeding a
doc from a snapshot, wrong for merging. Since a branch forks from its
parent, essentially every entity the branch *modified* was already present
in the merge target, so the merge landed only the branch's brand-new
entities and discarded all of the modifications: attributes, children,
inherits, psets, quantities, classifications, materials and geometry refs
alike.

A new `applyIfcxOverlay(doc, file)` applies an IFCX file as a layer of
opinions rather than as a seed, and `mergeBranch('layer')` now uses it. It
creates entities the doc lacks exactly as the seeder does; for entities
already present it writes the file's opinions on top — values overwrite,
`null` removes, an `ifclite::deleted: true` node deletes — and leaves
untouched anything the file says nothing about, so parent state added after
the fork survives the merge.

`seedFromIfcx` is unchanged in both its behaviour and its options: it stays
additive and idempotent, because `apps/viewer` and `snapshot/worker.ts` use
it to seed live session docs, where overlaying a snapshot onto live edits
would be the worse bug on the more common path.

One limit is worth stating plainly, since it is a property of the wire
format and not of this fix: a full IFCX snapshot emits only what an entity
*has*, so an entity or attribute the branch deleted is simply absent rather
than nulled or tombstoned. `mergeBranch('layer')` therefore still does not
propagate deletions made on the branch. `applyIfcxOverlay` does honour
deletions when a layer states them explicitly, as `extractMinimalLayer`
does.
