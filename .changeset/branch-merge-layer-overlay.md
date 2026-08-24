---
'@ifc-lite/collab': minor
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
`null` removes a flat attribute, child or inherit, an `ifclite::deleted:
true` node deletes — and leaves untouched anything the file says nothing
about.

Read that last clause narrowly. `mergeBranch('layer')` sends a FULL snapshot,
so the file has an opinion on nearly everything: a value the parent changed
after the fork is overwritten by the branch's fork-time value even when the
branch never edited it. This is the trade the release makes: previously a
layer merge dropped the branch's edits, now it applies them, and the price is
that the branch's fork-time value can win over a newer parent one. Attributes
and geometry behave the same way here; geometry is not a special case.

One consequence is specific to geometry. Blob GC derives the set it RETAINS
from the live doc and sweeps the complement, so reverting a `blobHash` flips
which blob counts as an orphan; a sweep between the parent's re-mesh and the
merge can leave the restored reference pointing at a blob that has been
deleted.

Geometry records go through `upsertGeometry` rather than `createGeometry`,
which returns an existing record untouched. Without that, a branch that
re-meshed geometry the parent already had merged "successfully" and left the
parent on the old blob hash.

`seedFromIfcx` is unchanged in both its behaviour and its options: it stays
additive and idempotent, because `apps/viewer` and `snapshot/worker.ts` use
it to seed live session docs, where overlaying a snapshot onto live edits
would be the worse bug on the more common path.

One limit is worth stating plainly, since it is a property of the wire
format and not of this fix: a full IFCX snapshot emits only what an entity
*has*, so an entity or attribute the branch deleted is simply absent rather
than nulled or tombstoned. `mergeBranch('layer')` therefore still does not
propagate deletions made on the branch. `applyIfcxOverlay` does honour
deletions when a layer states them explicitly.

A second limit, this one in the code: a nulled pset or quantity property is
NOT removed. `extractMinimalLayer` flattens those into
`bsi::ifc::v5a::<Set>::<Prop>` attribute keys, so the removal arrives as an
attribute null and is looked for in the flat attribute map, where it never
was. The property survives and the call returns normally. Only flat
attributes, children and inherits are removed today.
