---
"@ifc-lite/collab": minor
"@ifc-lite/collab-server": minor
---

Continuing the plan. Lands the production observability stack (v0.5),
blob GC (v0.3 / open #6), GDPR helpers (v1.0), and the worker-safe
snapshot entry point (v0.1 deferred).

`@ifc-lite/collab-server`
- `SnapshotWorker`: periodic per-room IFCX export to a writable
  directory. `runOnce()` for tests / cron. Skips idle rooms by default;
  `includeIdle: true` covers them too. Adds `@ifc-lite/collab` as a
  dep so we can call `snapshotToIfcx` directly.
- `MetricsRegistry` + Prometheus-text `/metrics` endpoint. Ships
  counter/gauge/lightweight-histogram. Built dependency-free so we can
  swap in `prom-client` later without API churn. Surfaces
  `collab_rooms`, `collab_room_peers{room}`, `collab_updates_total`,
  `collab_rejects_total{reason}`.
- `RoomManager.setCounters({ update, reject })` so the server can
  inject metric counters without leaking the registry into the manager.
- `createReplayProtector({ secret })` (open problem #8): HMAC-SHA256
  verifier for `(clientId, clock, payload)` envelopes with strict
  monotonic-clock enforcement. `computeHmac` is exported so non-Node
  clients can produce matching tags.

`@ifc-lite/collab`
- `BlobStore.stat(hash)` (optional): returns `BlobMeta` without
  downloading the bytes. Implemented for `MemoryBlobStore`,
  `createIndexedDbBlobStore`, and `HttpBlobStore` (HEAD).
- Blob GC (open problem #6): `collectReferencedBlobHashes(doc)`,
  `planBlobSweep(store, referenced, { epochMs })`, `sweepBlobs(store,
  decision)`. Walks every entity's `geometryRef.geomId` → resolves
  `blobHash`, also collects any 32-hex string in `geometry.params.*`
  so apps that store auxiliary refs in params survive.
- GDPR helpers: `exportAndLeave(session, { snapshot, serverDelete })`
  snapshots to IFCX, marks presence offline, runs the optional remote
  hard-delete hook, then disposes. `redactAuthorMeta(session)` blanks
  per-entity `createdBy` / `lastEditedBy` for anonymised exports.
- Worker-safe snapshot entry: new sub-export
  `@ifc-lite/collab/snapshot/worker` ships `runSnapshotWorker(self)`,
  a postMessage adapter that mounts a `(snapshot|seed)` request handler
  on a `DedicatedWorkerGlobalScope`. The pure `snapshotToIfcx` /
  `seedFromIfcx` helpers are also re-exported from this entry point so
  consumers that don't want the adapter still get a worker-clean
  surface.

Tests added (+18, total 101 passing): blob GC end-to-end (collect →
plan → sweep, plus epoch grace window), GDPR `exportAndLeave` happy
path / hook ok / hook failure / `redactAuthorMeta`, snapshot worker
postMessage round-trip (snapshot, seed, error report), server-side
`SnapshotWorker` writing IFCX files, metrics counters / gauges /
histogram and the `/metrics` endpoint serving Prometheus text, and
replay-protector HMAC happy path / tampered MAC / replay / payload
mismatch.

Plan doc updated with v0.3 / v0.5 / v1.0 status badges.
