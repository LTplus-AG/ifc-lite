---
"@ifc-lite/collab": minor
"@ifc-lite/collab-server": minor
---

Continuing the plan. Lands operational v0.5 pieces, the v0.7 branching
starter, and v1.0 schema-migration scaffolding.

`@ifc-lite/collab-server`
- `JsonlFileAuditSink`: append-only NDJSON file sink with size-based
  rotation (`rotateAtBytes`) and an opt-in `fsync`-after-append mode for
  durable audit trails.
- Idle room unloading: `idleUnloadMs` knob plumbed end to end. The
  manager runs an internal `unref()`'d sweep timer at half the idle
  window; `sweepIdle()` is also callable directly. Persistence keeps the
  durable copy, so unloading is non-destructive.
- Retention policy: `planRetention(dir, policy)` + `applyRetention`.
  Honors `fullLogDays` (default 90), `snapshotsDays` (default 5y), and
  `maxBytesPerRoom` (trim oldest first). Pluggable file classifier so
  custom naming schemes work too.
- `RoomManager.stats()` returns `(roomId, peerCount, idleMs)` triples
  for diagnostics and tests.

`@ifc-lite/collab`
- Schema-version helpers (open problem #2 prep): `getSchemaVersion`,
  `setSchemaVersion`, `registerSchemaMigration`, `migrateSchema`, plus
  a `MIGRATION_ORIGIN` symbol so observers can filter migration
  transactions out of e.g. undo stacks.
- v0.7 branching starter: `forkSession(parent, { name })` snapshots the
  parent's Y.Doc, seeds a fresh sibling session, and stamps
  `meta.branch.parentRoomId` / `branch.name` / `branch.forkedAt`.
  `mergeBranch(parent, branch, strategy)` implements both `'ops'`
  (Y-update apply with last-write-wins on conflicts) and `'layer'`
  (IFCX snapshot + non-resetting re-seed). Returns a small
  `MergeReport`. `readBranchMeta` exposes the metadata back.

Tests added (+12, total 83 passing): JSONL append + rotation, retention
plan + apply (full-log days, snapshots days, maxBytesPerRoom),
RoomManager idle sweep with both empty and busy rooms, schema-version
round-trip + a sample migration that renames an attribute namespace,
and end-to-end branch fork → divergent edits → merge for both strategies
including a non-conflicting parent-edit-survives case.
