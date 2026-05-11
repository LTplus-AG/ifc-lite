---
"@ifc-lite/collab": minor
"@ifc-lite/collab-server": minor
---

v0.1 Foundation of `@ifc-lite/collab` — real-time collaborative BIM via CRDT
on IFCX, plus a reference websocket sync server. New packages.

`@ifc-lite/collab` ships:

- Y.Doc schema with `entities` / `relationships` / `geometry` top-level
  shared types and helpers for every operation in the spec §6 table
  (create, delete, set attribute, set Pset property, hierarchy move, type
  promotion, relationship target add/remove, geometry param/blob updates).
- IFCX seed (`seedFromIfcx`) and snapshot (`snapshotToIfcx`) with full
  round-trip against the buildingSMART hello-wall fixture.
- Per-user layer extraction filtered by `clientID`.
- IndexedDB and websocket providers, plus an in-memory provider for tests.
- Awareness / presence helpers (3D + 2D cursors, selection, camera, view,
  section, isolation, tool, status) at 30 Hz with stale eviction.
- Y.UndoManager wrapper scoped to a local-origin tag, so a peer's `undo()`
  only rolls back their own edits.
- Conflict detector backed by `Transaction.changed` (catches LWW losses
  even when `YEvent.keys` is empty).
- `createCollabSession` glues the above into the public façade documented
  in spec §16.2.

`@ifc-lite/collab-server` ships:

- `y-websocket`-compatible sync (`y-protocols/sync` + awareness on the
  same socket).
- In-memory and append-only-file persistence with periodic compaction.
- JWT auth hook (`AuthenticateFn`) and role-based write capability check.
- Healthcheck endpoint and clean shutdown.
- `ifc-lite-collab-server` CLI binary.

Tests cover schema round-trips, the buildingSMART hello-wall fixture,
two-peer convergence with conflict-detector firing on both peers,
end-to-end sync through the websocket server, undo isolation, and
per-user layer extraction.

See `docs/architecture/collab-plan.md` for the v0.1 → v1.0 roadmap.
