# @ifc-lite/collab

## 0.2.0

### Minor Changes

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Final integration batch. Closes the last cross-cutting items in the
  plan: the spec §16.3 mutations bridge, open problem #7 (per-section
  locks), the viewer-mount one-liner, the TLS bundle helper, and a
  runnable performance benchmark suite. **+11 tests, total 175 passing.**

  `@ifc-lite/collab`

  - **`bindMutationsToCollab(view, session, opts)`** (spec §16.3): wraps
    `@ifc-lite/mutations` `MutablePropertyView` so legacy STEP property
    edits mirror to the Y.Doc whenever a collab session is bound. The
    view's existing observers / change-set tracking still fire; reads
    pass through. `resolveEntity(id)` translates numeric expressIds to
    IFCX paths; returning `null` skips the mirror for that mutation.
    `PROPERTY_TYPE_NAMES` maps `PropertyValueType` enum values to the
    IFCX type strings stored on `PropertyValue`.
  - **`mountPresenceInViewer({ session, container, viewport })`** (spec
    §7 viewer mount): one-line glue that creates a presence overlay,
    forwards `mousemove → setCursor2d`, and returns a `teardown()`.
  - **`runPerfBenchmarks(budget?)`** (§15): self-contained Node-runnable
    benchmarks measuring single-attribute update size, cold-load time
    for a 1k-entity fixture, and (gated by `COLLAB_BENCH_HEAVY`) state-
    vector size at 100k entities. Each result reports
    `{ name, value, unit, budget, ok }`. Useful for `vitest` perf
    regression coverage and CI smoke tests.

  `@ifc-lite/collab-server`

  - **Per-section locks (open #7).** `createPathLockRegistry()` →
    `add({ prefix, label?, exemptUserIds?, exemptRoles? })` /
    `remove(lock)` / `matches(path, principal)` / `clear()`.
    `verifyAgainstPathLocks(registry)` returns a `VerifyMessageFn`
    that decodes incoming sync-update frames, runs them through a
    throwaway Y.Doc to harvest touched paths, and rejects writes that
    intersect any locked prefix (audit reason `locked:<label>`).
    `harvestUpdatePaths(update)` is exposed for tests + custom
    filtering. Path format: `entities/wall`, `geometry/g7`, etc.
  - **`startSecureCollabServer(opts)`**: bundles `createSecureHttpServer`
    - `secureHttpHandler` + `startCollabServer` so deployers get
      TLS-in-process plus the OWASP-baseline header wrapper without
      writing the wiring.

  Tests added (+11): mutations bridge happy path / null-resolve / delete
  mirror, path-lock registry add/match/remove + path harvesting + raw-WS
  rejection of writes to a locked prefix, perf benchmarks for
  single-attr-update / cold-load / runPerfBenchmarks happy paths,
  secure-bundle smoke test (rejects missing cert paths), viewer-bridge
  overlay mounting + mousemove forwarding + clean teardown via a
  hand-rolled DOM stub.

  Plan doc: v0.1 ☑ (mutations bridge added), v0.2 ☑ (mount-in-viewer
  shipped), v0.5 ☑ (TLS bundle + per-section locks). Open problems are
  closed in this batch as follows: problem #7 (per-section locks) is
  new in this PR; problems #1, #2, #3, #4, #5, #6, #8, #9, #10 were
  already closed in prior batches.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Big reach-for-the-stars batch. Closes (or near-closes) the remaining
  substantial items in `docs/architecture/collab-plan.md` for v0.2,
  v0.5, v0.7, and v1.0. **+21 tests, total 140 passing.**

  `@ifc-lite/collab`

  - **History sidecar (v0.7).** `HistorySidecar` interface with
    `MemoryHistorySidecar` ship and an `AutomergeHistorySidecar` slot
    reserved (matching the same interface). Records, time-travels, diffs
    per-entity-id, branches, merges. `attachHistorySidecar(session,
sidecar, opts)` drives a sidecar from a live `CollabSession` on a
    configurable interval + on demand, with optional differential
    layers in each entry for cheap diff queries.
  - **End-to-end encryption (v1.0).** WebCrypto-based suite:
    `deriveRoomKey` (PBKDF2-SHA256, 200k iterations default),
    `generateRoomKey` / `exportRoomKey` / `importRoomKey`,
    `encryptFrame` / `decryptFrame` with versioned
    `[1B ver][12B IV][N B AES-GCM]` framing, and a `KeyRing`
    (`createKeyRing(initial, { gracePeriodMs })`) so in-flight frames
    decode through retired keys for the configured grace window.
  - **Presence-renderer math (v0.2).** `peerVisuals(peers, opts)` turns
    a `PresenceMap` into render-ready `{ color, label, opacity,
isStale, cursor3d, cursor2d, selection, modelId }`. Color resolution
    uses `colorForUser` against either the human or agent palette
    depending on the `(agent)` suffix; opacity fades over `staleAfterMs`.
    `cursorScreenPosition` projects 2D cursors per viewport.

  `@ifc-lite/collab-server`

  - **S3 persistence (v0.5).** `S3Persistence` against an injectable
    `S3LikeClient` + `S3Commands` shape — AWS SDK, R2, MinIO, or any
    S3-compatible client all fit without forcing
    `@ifc-lite/collab-server` to depend on `@aws-sdk/client-s3`.
    Per-room layout: `<prefix><room>.snap` for compacted state plus
    `<prefix><room>.log/<NNNNNNNNNN>.bin` for rolling log frames.
    Implements load / append / compact / drop with `frameMaxBytes`
    enforcement.
  - **Anti-replay wired into the message path (v0.5 / open #8).**
    `RoomOptions.verifyMessage: VerifyMessageFn` runs before rate-limit
    / role-check. Rejects audit as `reject` with the supplied reason.
    `verifyWithReplayProtector(protector, { requireSigned })` adapts the
    existing `ReplayProtector` for the hook. `encodeSignedFrame` /
    `decodeSignedFrame` ship a default
    `[0xff][4B clientId][4B clock][64B HMAC][N B payload]` envelope so
    apps don't have to invent one.
  - **TLS / secure-server helpers (v0.5).** `createSecureHttpServer`
    with strong defaults (TLS 1.2+, conservative cipher list, ALPN
    `http/1.1`, optional CA bundle for mTLS), `applySecurityHeaders` for
    the OWASP-baseline response headers (HSTS, no-sniff, frame deny,
    no-referrer), and `secureHttpHandler(inner)` to wrap an existing
    request handler with the headers + TRACE/TRACK rejection.

  Tests added (+21):

  - `history` — record / list / time-trace, diff added/removed/changed,
    branch + merge, session-driven captures with diff entries.
  - `e2e-encryption` — derive → encrypt → decrypt round-trip,
    cross-salt rejection, wrong-key rejection, export/import preserves
    decryption, key ring grace period, post-grace key drop.
  - `render` — color/label/opacity resolution, stale fading, local-peer
    exclusion, cursor projection by viewport.
  - `replay-wired` — server rejects unsigned frames when
    `requireSigned`, signed frame decodes + clock-tracks, replay
    rejected.
  - `secure-server` — security headers applied, TRACE/TRACK rejected
    via raw socket (undici blocks TRACE client-side).
  - `persistence-s3` — append + load round-trip, compact replaces snap
    and clears log, drop removes everything.

  Plan doc has updated v0.2 / v0.5 / v0.7 / v1.0 status badges. v0.5
  and v0.7 and v1.0 are now ☑ on every item that lives inside these
  two packages; remaining work for v0.5 (Redis persistence,
  full-bucket histograms) and v0.7 (`AutomergeHistorySidecar`) is
  opt-in extension that doesn't block GA.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Tackle-everything batch. Closes the remaining substantial items in the
  plan for v0.2, v0.3, v0.4, v0.5, v0.7, and v1.0. **+37 tests, total
  164 passing.**

  `@ifc-lite/collab`

  - **`AutomergeHistorySidecar`** (v0.7): real `@automerge/automerge`
    3.x implementation. Same `HistorySidecar` interface as the in-memory
    variant; adds binary `save()` / `load(bytes)` for
    cross-restart persistence. Branches and merges round-trip through
    the Automerge doc.
  - **`buildBranchTree(sidecar)`** (v0.7): pure-data branch-tree
    builder. Returns `{ nodes, edges, branches }` with `branch-anchor` /
    `entry` / `merge` node kinds and `history` / `fork` / `merge` edge
    kinds. Apps render this directly into git-log columns or
    force-directed graphs.
  - **Parametric mesh primitives** (v0.3): pure-TS reference kernel.
    `paramsToMesh(source, params)` ships `extruded-area-solid`, `box`,
    `cylinder`, and `revolved-area-solid`. `hashMesh(mesh)` returns a
    32-hex content hash for cache keys.
  - **Determinism harness** (v0.3 / open #5):
    `runDeterminismHarness(kernel, fixtures, expected)` + a
    `DEFAULT_FIXTURES` set covering every primitive. CI runs this on
    every platform and fails on drift.
  - **`createWebRtcProvider`** (v0.2 §8.1): wraps `y-webrtc` lazily so
    consumers who don't use it pay no bundle cost. Same status /
    whenSynced shape as the websocket provider.
  - **`createNumericRegistryAdapter(registry)`** (v0.4): bridges the
    renderer's existing numeric-offset `FederationRegistry` into our
    string-shaped `FederationResolver` without forcing
    `@ifc-lite/collab` to depend on the renderer.
  - **`installIfc4ToIfc4x3Migration()`** (v1.0): sample registered
    schema migration that renames `Pset_<…>::<key>` attributes into
    the `bsi::ifc::v5a::Pset_<…>::<key>` namespace. Demonstrates the
    migration plumb for consumers.
  - **`createPresenceOverlay({ container, viewport })`** (v0.2): drop-in
    2D canvas overlay that consumes a `PresenceMap` and draws other
    peers' cursors + label badges. `update(peers)` redraws; auto-resizes
    via `ResizeObserver`. Pairs with `peerVisuals` for any DOM viewer.

  `@ifc-lite/collab-server`

  - **`RedisPersistence`** (v0.5): `Persistence` against a
    `RedisLikeClient` interface (ioredis / node-redis 4+ satisfy it).
    Layout: `<prefix><roomId>:snap` for compacted state, list
    `<prefix><roomId>:log` for rolling frames. Implements
    load / append / compact / drop.
  - **Bucketed histograms** (v0.5): `MetricsRegistry.bucketedHistogram(
name, buckets, help)` accumulates observations into upper-bound
    buckets and renders as a proper Prometheus `histogram` type with
    `le="<bound>"` bucket labels.

  Tests added (+37): Automerge sidecar record / save+load / diff /
  branch+merge; branch-tree anchor + history edges, fork edges, merge
  edges with merge-from-branch annotation; parametric primitives shapes

  - deterministic hashes + dispatch errors; determinism harness happy
    path + drift detection; numeric registry adapter forwarding + numeric
    guard; IFC4 → IFC4X3 sample migration verifying renames; Redis
    persistence append/load + compact/clear + drop; bucketed histograms
    counts + label dimensions + empty-bucket guard.

  Plan doc: v0.2 ☑ (overlay shipped), v0.3 ☑ (parametric kernel +
  determinism harness), v0.4 ☑ (numeric registry adapter), v0.5 ☑
  (Redis + bucket histograms), v0.7 ☑ (Automerge sidecar + branch
  tree). v1.0 was already ☑; the sample migration finishes the §1.x
  "actually IFC schema migrations" caveat.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - `@ifc-lite/collab` follow-up: deterministic per-user color hash exposed
  publicly (`colorForUser`, `DEFAULT_USER_PALETTE`, `fnv1a`) and consumed
  automatically by `Presence.setUser` when the caller doesn't supply a color.
  `UserIdentity.color` is now optional.

  Conflict detector tightened: only flags concurrent deletes (not creates) at
  the entity top level, and now also surfaces concurrent Pset-creation as a
  `pset-property` event keyed by Pset name.

  `@ifc-lite/collab-server` follow-up: an append-only audit log
  (`AuditSink`, `MemoryAuditSink`, `noopAuditSink`, `shortHash`) that records
  `(timestamp, user, room, op-type, op-hash)` for every connect, sync,
  update, awareness, and reject event; and a per-peer rate limiter
  (`createRateLimiter`, `RateLimitOptions`) wired into the room's update
  filter. Editor-or-better roles get a 200-token / 60-tps default bucket;
  `startCollabServer` accepts a function form so service accounts can have
  tighter budgets than humans.

  Tests added: 23 new (color, audit + rate limit, disconnect/reconnect,
  property-based convergence with seeded random traces, conflict scenarios
  for each `ConflictKind`, broader entity-op coverage). Total now 49.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - v0.1 Foundation of `@ifc-lite/collab` — real-time collaborative BIM via CRDT
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

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Continuing the v0.1 → v1.0 plan. Lands foundational pieces of v0.3
  (geometry), v0.4 (federation), and v0.6 (MCP) so each upstack consumer
  has stable shapes to build on.

  `@ifc-lite/collab`

  - Blob store: content-addressed put/get/has/delete/list with a stable
    32-hex `fnv128` hasher. Backends: `MemoryBlobStore`,
    `createIndexedDbBlobStore` (browser only, lazy-loaded), `HttpBlobStore`,
    and `LayeredBlobStore(local, remote)` for local-first read-through and
    parallel write-through.
  - CSG-tree CRDT: `ensureCSGTree`, `appendCSGOp`, `insertCSGOp`,
    `removeCSGOp`, `moveCSGOp`, `getCSGOps`. Stored as `Y.Array<CSGOp>` on
    the geometry node's `params.ops` so concurrent appends interleave
    per-peer-relative-order. Order-dependence of the resulting solid is
    documented as a v0.1 limitation; full CRDT-tree merging is open
    problem #4 (v1.x).
  - Conflict UI bridge: `createConflictUIBridge(detector)` folds detector
    events into stable `(kind, path, field)` buckets and emits
    `open` / `update` / `close` lifecycle events. Buckets close on
    idle (`closeAfterMs`, default 4 s) or via explicit `resolve(key)`.
  - Agent presence helper: `markAsAgent`, `agentIdentityFromMcp`,
    `AGENT_PALETTE`. Standardized convention so the viewer can render MCP
    tool peers with a `(agent)` suffix and a distinct color band.
  - `FederationSession` (spec §10): hosts N per-model `CollabSession`s
    plus a shared `_federation` Y.Doc for cross-model
    `FederationRecord`s (clash, RFI, view, BCF refs). Presence is
    project-scoped via the `_federation` doc per §10.2. APIs:
    `createFederationSession`, `addModel`, `removeModel`, `upsertRecord`,
    `getRecord`, `removeRecord`, `listRecords`, `observeRecords`.

  `@ifc-lite/collab-server`

  - Blob HTTP route: `PUT /blobs/<hash>`, `GET /blobs/<hash>`,
    `HEAD /blobs/<hash>`, `DELETE /blobs/<hash>`, `GET /blobs` (list).
    Pluggable `ServerBlobStorage` (default `InMemoryBlobStorage`,
    swappable for S3/disk) and configurable `blobMaxBytes` (default
    100 MB) for payload-too-large rejection.

  Tests added (+22, now 71 total — all passing): blob store backends,
  CSG concurrent appends, UI-bridge open/update/close + explicit resolve,
  agent presence (suffix idempotence, deterministic id from MCP input),
  FederationSession (multi-model rooms, record CRUD, observeRecords), and
  the server's blob route end-to-end (round-trip, malformed-hash 400,
  413 on payload-too-large).

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Continuing the plan. Lands the production observability stack (v0.5),
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

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Continuing the plan. Lands operational v0.5 pieces, the v0.7 branching
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

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Continuing the plan. Lands the differential layer composer (v0.7), the
  property unit converter (v1.0 / open problem #3), conflict resolver
  actions on the UI bridge, the `FederationResolver` interface, and the
  network-latency simulation perf harness (v0.2).

  - `extractMinimalLayer(doc, baseline, opts)`: produces an IFCX layer
    containing only the entities and fields that changed since
    `baseline`. Entities created since baseline are emitted whole;
    entities that already existed only get their changed attributes /
    children / inherits keys. Toggle whether updated values count as
    diffs via `includeUpdatedValues`.

  - `convertEntityUnits(doc, from, to)` walks every Pset and converts
    numeric `PropertyValue`s with a matching `unit`. Ships SI-relative
    scale tables for length (m/cm/mm/in/ft), area (m²/cm²/mm²/ft²/in²),
    volume (m³/cm³/mm³/L), and angle (rad/deg). `convertValue(value,
from, to)` is exposed for one-shot conversions. `familyOf(unit)`
    classifies a unit string.

  - Conflict UI bridge: `bridge.keepMine(key)` and `bridge.acceptTheirs(key)`
    run registered handlers (per `ConflictKind`) and close the bucket.
    Handlers receive `{ bucket }` and are responsible for emitting the
    follow-up CRDT edit.

  - `FederationResolver` interface: typed `toGlobalId / fromGlobalId /
getModelForGlobalId` contract. `passThroughResolver` is the default
    for IFCX UUID paths (globally unique by construction).
    `createMapBackedResolver(table)` covers explicit lookup tables. The
    renderer's existing numeric-offset `FederationRegistry` can be
    wrapped to satisfy the interface without forcing `@ifc-lite/collab`
    to depend on the renderer (adapter snippet documented in source).

  - `createLatencyChannel(a, b, { baseMs, jitterMs, dropRate, random })`
    wraps a pair of Y.Docs with a queued, time-bucketed update channel.
    `flushUntil(t)` advances simulated time and dispatches due updates.
    Useful for benchmarking the §15 perf budget under simulated network
    conditions.

  Tests added (+18, total 119 passing): minimal-layer round-trips and
  diff-only behaviour, unit conversion across families plus skipping on
  mismatched unit, bridge `keepMine` / `acceptTheirs` lifecycle including
  follow-up CRDT writes from handlers, resolver pass-through and
  map-backed lookups, latency channel arrival-time behaviour and
  deterministic drop rate under a seeded PRNG.

## 0.1.0

### Minor Changes

- Initial release. v0.1 Foundation per `docs/architecture/collab-plan.md`:
  - Y.Doc schema with `entities`, `relationships`, `geometry` top-level maps.
  - IFCX seed (`from-ifcx`) and snapshot (`to-ifcx`) round-trip.
  - Per-user layer extraction.
  - IndexedDB and websocket providers.
  - Awareness / presence helpers (3D + 2D cursors, selection, camera).
  - Y.UndoManager wrapper scoped to local origin.
  - Conflict detector + UI-bridge event emitter.
  - `createCollabSession` public API binding the above together.
