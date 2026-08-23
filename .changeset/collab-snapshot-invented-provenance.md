---
'@ifc-lite/collab': patch
'@ifc-lite/ifcx': patch
---

Stop a collab snapshot round trip from inventing per-entity provenance, and carry the real thing on the wire.

`snapshotToIfcx` wrote nothing about who created an entity or when, because
IFCX nodes had no provenance slot. `seedFromIfcx` then filled both fields in
from the file header — which names whoever serialized the *file*, not
whoever authored each entity, and for a snapshot of a collab doc that is the
snapshotter plus the write clock. An entity carrying `createdBy: 'ada'` /
`createdAt: '2019-05-05'` came back claiming a different author and a
different date, in a shape indistinguishable from genuine attribution. A
missing field reads as "unknown"; a fabricated one gets trusted.

Two changes:

- **A wire carrier.** `ifclite::meta` (new member of `IFCLITE_ATTR`, the
  extension namespace that already carries collab's classifications,
  materials and geometry refs) holds `createdBy`, `createdAt`,
  `lastEditedBy`, `lastEditedAt` and `previousPath`, so real provenance
  survives snapshot → seed. Values are shape-gated on the way in: only
  strings are read, and a foreign value under the key stays an ordinary
  flat attribute. Every field carried is written once at entity creation
  and never re-stamped — a per-edit stamp would put this attribute in
  every minimal layer and give the merge engine a component that conflicts
  on every concurrent edit.
- **No more header defaults.** `seedFromIfcx` and `seedFromStep` no longer
  copy `header.author` / `header.timestamp` onto every entity, and no longer
  stamp the read clock as `createdAt`. What the wire does not say now stays
  unset. The file-level record is still available as `meta.header` /
  `meta.stepHeader`.

`createEntity` also now writes the `bsi::ifc::class` attribute when given an
`ifcClass`. `meta.ifcClass` is doc-local bookkeeping with no wire form, so
an entity whose class was only ever passed as that option snapshotted
without a class and came back classless; the MCP draft path had already
open-coded the attribute at its own call site to work around this.

Scope: `lastEditedBy` / `lastEditedAt` survive only because nothing
re-stamps them today. Relationships (the doc's separate `relationships`
map) still do not survive a snapshot — IFCX has no relationship node and
no first-party writer populates that map; `snapshot-relationships.test.ts`
pins that as a tripwire rather than papering over it.
