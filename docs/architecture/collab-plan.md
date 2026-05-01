# `@ifc-lite/collab` — Implementation Plan & Task Tracker

**Spec:** `Spec: @ifc-lite/collab — Real-time collaborative BIM via CRDT on IFCX` (Draft v0.1, target ifc-lite 3.0).
**Branch:** `claude/plan-task-tracking-XyeJi`.
**Owner:** Louis Trümpler (LT+).
**Status legend:** ☐ pending · ◐ in progress · ☑ done · ⚠ blocked.

This document is the source of truth for tracking the rollout of CRDT-backed
collaboration on top of IFCX. Each phase maps 1:1 to the roadmap in §19 of the
spec. Each task has a concrete artifact (file path, package, or interface) so
progress is unambiguous. Cross-cutting concerns (testing, performance budget,
open problems) are listed once at the end and referenced from each phase.

---

## 0. Working agreements

- **Branch hygiene:** every phase ships behind a feature flag (`collab.enabled`)
  and lands on `main` only after its exit criteria are green.
- **Two new packages** are created up front so PRs from every phase land in
  stable locations:
  - `packages/collab/` — client runtime (Y.Doc, providers, snapshot, awareness)
  - `packages/collab-server/` — reference sync server (`y-websocket` compatible)
- **Conventions to honor (from `AGENTS.md`):**
  - Strict IFC nomenclature in user-facing APIs (`IfcRelAggregates`, not
    `Aggregates`); Pset / property names in PascalCase.
  - Federation-aware IDs: never bypass `FederationRegistry` for cross-model
    lookups.
  - License headers on every new `.ts` / `.rs` source file.
  - Changesets for any change that touches a published package.
  - File size cap ~400 LOC; no `as any`, no bare `catch {}`.
  - Tests required for every new package and feature.
- **Dependencies (added once, in the right package — never the root):**
  - `packages/collab`: `yjs`, `y-protocols`, `y-indexeddb`, `y-websocket`,
    `y-webrtc` (optional), `lib0`.
  - `packages/collab` (history sidecar, v0.7 only): `@automerge/automerge`.
  - `packages/collab-server`: `ws`, `y-websocket` (server bits), `jsonwebtoken`,
    plus a persistence driver chosen at v0.5 time (`@aws-sdk/client-s3` or
    `ioredis`).

---

## 1. Phase v0.1 — Foundation (4 weeks)

> **Status: ☑ Landed.** Both `packages/collab` and `packages/collab-server`
> ship in this PR. `pnpm --filter @ifc-lite/collab test` and
> `pnpm --filter @ifc-lite/collab-server test` pass 19 tests including a
> round-trip against the buildingSMART hello-wall fixture, two-peer
> convergence with the conflict detector firing on both peers, end-to-end
> sync through the websocket server, undo isolation, and per-user layer
> extraction. The `Web Worker snapshot` and `Bim.fromFile binding` items
> are deferred to follow-on PRs (the worker is an apps-layer concern; the
> SDK binding is a v0.2 task once the existing mutation layer migrates).

**Goal:** A single peer can open an `.ifcx` file, mutate it through a Y.Doc
that mirrors the spec's data model, persist edits to IndexedDB, and snapshot
the Y.Doc back out to a valid `.ifcx`. No network, no presence, no conflict
resolution UX yet.

**Spec sections:** §5 data model, §6 operations mapping, §6.1 tombstones &
undo, §12.1 local persistence, §12.3 IFCX snapshots (single-peer slice),
§16.1 package structure, §17 migration path.

### 1.1 Package scaffolding

- ☑ Create `packages/collab/` with `package.json`, `tsconfig.json` extending
  `tsconfig.packages.json`, MPL license header, README, CHANGELOG.
- ☐ Add `packages/collab` and `packages/collab-server` to
  `pnpm-workspace.yaml` (already covered by `packages/*` glob — verify).
- ☐ Add a changeset describing the new `@ifc-lite/collab` package at minor
  version `0.1.0`.
- ☐ Wire `packages/collab` into `turbo.json` build pipeline.

### 1.2 Y.Doc schema (§5)

Implement in `packages/collab/src/doc/schema.ts`:

- ☐ `createCollabDoc()` returns a `Y.Doc` with three top-level shared types:
  `entities` (`Y.Map<EntityDoc>`), `relationships` (`Y.Map<RelationshipDoc>`),
  `geometry` (`Y.Map<GeometryRef>`).
- ☐ Type definitions for `EntityDoc`, `RelationshipDoc`, `GeometryRef`,
  `PropertyValue` (mirror §5.1–§5.3 verbatim, including
  `attributes: Y.Map<Y.Map<unknown>>` keyed by namespace).
- ☐ `assertSchemaInvariants(doc)` — runtime check that the three top-level
  maps exist and have the expected key shapes. Used in tests and in
  `from-ifcx` seeding.
- ☐ Property-shaped helpers (`packages/collab/src/doc/entity.ts`,
  `relationship.ts`, `geometry.ts`) implementing the operations table in §6:
  create, delete, set attribute, set Pset property, classification add,
  material assign, hierarchy move, geometry replace, type promotion
  (delete + create with `meta.previousPath`).
- ☐ Every user-facing edit wraps in `ydoc.transact(() => …, origin)` for
  atomicity and undo grouping.

### 1.3 IFCX seeding & snapshotting (§12.3, §17)

In `packages/collab/src/snapshot/`:

- ☐ `from-ifcx.ts`: parse `.ifcx` (use `@ifc-lite/ifcx` reader), build a Y.Doc
  whose state matches the composed IFCX. Idempotent: seeding twice with the
  same file produces structurally equal Y states.
- ☐ `to-ifcx.ts`: traverse Y.Doc → produce IFCX `data[]` records. Round-trip
  test: `seed → snapshot → seed` must converge.
- ☐ `layers.ts`: extract a per-user layer file using Yjs's update history
  filtered by `clientID`. Output a valid `.ifcx` whose composition with the
  base produces the same state as the live Y.Doc.
- ☐ Snapshotting runs in a Web Worker (`apps/*` consumer wires the worker;
  package exports a worker-compatible entry point).

### 1.4 Local persistence (§12.1)

- ☐ `packages/collab/src/providers/indexeddb.ts`: thin wrapper over
  `y-indexeddb` keyed by `roomId`. Always-on for any session.
- ☐ Cold load <3s for 100k entities (perf budget §15) — measured by a
  benchmark in `packages/collab/test/perf.bench.ts`.

### 1.5 Undo / tombstones (§6.1)

- ☐ `packages/collab/src/undo.ts` exports `createUndoManager(doc, origin)`
  built on `Y.UndoManager`, scoped to the local origin.
- ☐ "Deleted entities" view: read tombstones from Y state and expose a
  recovery API (`session.restoreDeleted(path)`).
- ☐ GC at snapshot boundary: when `to-ifcx` runs, tombstones older than the
  snapshot timestamp are purged.

### 1.6 Public API surface (§16.2)

- ☐ `packages/collab/src/index.ts` exports `createCollabSession(opts)` with
  the v0.1 subset: no network, just `bind(bim)`, `snapshot()`, `dispose()`.
- ☐ Bind into `@ifc-lite/sdk`: `Bim.fromFile('model.ifcx', { collab })` —
  add a `collab?: CollabSession` option to the existing `Bim.fromFile`.
- ☐ Mutations from `@ifc-lite/mutations` route through the Y.Doc when a
  session is bound; otherwise behave as today (no regression).

### 1.7 Tests (v0.1 exit criteria)

- ☐ Unit tests for every helper in `doc/`, `snapshot/`, `undo.ts`.
- ☐ Round-trip property test: random IFCX → seed → snapshot → IFCX, must be
  semantically equal (entity set, relationships, attributes).
- ☐ Convergence smoke test (single-peer): apply a recorded edit trace from a
  fixture, snapshot, re-seed, verify identical Y state.
- ☐ Perf benchmark: cold load + first edit on 100k-entity fixture under
  budget.

**Exit criteria:** open `model.ifcx`, edit through `bim.mutate.*`, reload the
tab, see edits restored, export `.ifcx`, diff against expected fixture.

---

## 2. Phase v0.2 — Multi-peer (4 weeks)

> **Status: ◐ Mostly landed.** The websocket provider, awareness/presence
> types, sync server (`y-protocols/sync` over `ws`), in-memory + file
> persistence, JWT auth hook, healthcheck, and end-to-end two-client
> convergence test are all in. The latency-simulation perf harness now
> ships as `createLatencyChannel(a, b, { baseMs, jitterMs, dropRate })`.
> The remaining v0.2 item is viewer-side rendering of cursors /
> selection outlines (consumed by `packages/viewer`).

**Goal:** Two browsers in the same room see each other's edits and cursors in
real time over a websocket.

**Spec sections:** §7 awareness protocol, §8 sync protocol, §8.1 providers
(websocket only at this phase), §15 perf budget for sync.

### 2.1 Sync server

- ☐ Scaffold `packages/collab-server/` with the layout in §16.1:
  `server.ts`, `room-manager.ts`, `persistence.ts`, `auth.ts`.
- ☐ Implement a `y-websocket`-compatible server in `server.ts` using `ws`.
  Per-room Y.Doc held in memory; updates fanned out to all peers in the room.
- ☐ Persistence (v0.2 minimal): append-only file log per room on disk.
  Compaction policy comes in v0.5.
- ☐ Healthcheck endpoint `/healthz` and a single-instance dev script
  (`pnpm --filter @ifc-lite/collab-server dev`).

### 2.2 Client provider

- ☐ `packages/collab/src/providers/websocket.ts` — wraps `y-websocket` with
  reconnect/backoff and a `status` observable (`connected | connecting |
  offline | error`).
- ☐ `packages/collab/src/sync/room.ts` — joins/leaves rooms, exposes
  `session.status`.
- ☐ Extend `createCollabSession({ provider: 'websocket', serverUrl, … })`.

### 2.3 Awareness (§7)

- ☐ `packages/collab/src/awareness/protocol.ts` — wraps
  `y-protocols/awareness` on the same transport as the Y.Doc updates, on a
  separate channel.
- ☐ `packages/collab/src/awareness/presence.ts` — typed `PresenceState` per
  §5.4 (`cursor3d`, `cursor2d`, `selection`, `camera`, `activeView`,
  `activeSection`, `isolated`, `tool`, `status`).
- ☐ Stable per-user color hash from user ID.
- ☐ Stale presence eviction within 10s of disconnect.
- ☐ Update rate cap at 30 Hz with delta-only payloads.

### 2.4 Viewer integration (cursors, selections)

- ☐ `packages/viewer` consumes `session.presence` and renders:
  - 3D cursors as floating arrow + name tag at world-space hit-point under
    each peer's screen cursor.
  - Selection outlines per peer in their assigned color (re-uses existing
    selection shader; new uniform for peer color).
- ☐ Settings toggle to hide other users' cursors / selections.

### 2.5 Tests

- ☐ Two-peer integration test in `packages/collab/test/multi-peer.test.ts`
  using two Y.Docs over an in-process server: edits on A appear on B within
  budget; awareness updates flow.
- ☐ Disconnect/reconnect test: A goes offline, edits, comes back, B converges.
- ☐ Network-latency simulation for §15 sync targets (LAN <50ms,
  intercontinental <300ms with simulated 200ms RTT).

**Exit criteria:** demo two browsers in different windows editing the same
wall's `Name` and seeing each other's cursors. This is the LinkedIn-demo
milestone called out in §19.

---

## 3. Phase v0.3 — Geometry (6 weeks)

> **Status: ◐ Foundations + GC landed.** Content-addressed blob store
> (`MemoryBlobStore`, `IndexedDbBlobStore`, `HttpBlobStore`,
> `LayeredBlobStore`) and the matching server route
> (`PUT/GET/HEAD/DELETE /blobs/<hash>` + `GET /blobs`) are in. CSG-tree
> CRDT (`Y.Array<CSGOp>` with append/insert/remove/move) is in.
> Conflict UI bridge (`createConflictUIBridge`) emits open/update/close
> bucket lifecycle events. **Blob GC** (open problem #6) now ships:
> `collectReferencedBlobHashes(doc)`, `planBlobSweep(store, ref, opts)`,
> `sweepBlobs(store, decision)` — epoch + reference-count sweep over
> any `BlobStore` implementing the optional `stat()` method. Still
> pending: parametric → mesh kernel hookup, viewer-side conflict badge,
> and the determinism CI matrix.

**Goal:** Geometric edits (parametric and mesh) sync correctly without
inflating Y.Doc memory or requiring central authority.

**Spec sections:** §5.3 geometry refs, §9.4 geometry conflicts, §11 deep
dive, §15 perf (mesh data must NOT be in Y.Doc).

### 3.1 Blob store

- ☐ `packages/collab/src/geometry/blob-store.ts` — content-addressed blob
  store with two backends:
  - Local: IndexedDB object store keyed by hash.
  - Remote: HTTP `PUT/GET /blobs/:hash` against `collab-server`.
- ☐ Server route `packages/collab-server/src/blobs.ts` with size limits and
  per-room quota.
- ☐ Reference-counting GC sketch (full GC scheme deferred per open
  problem #6).

### 3.2 Parametric geometry as CRDT (§11.2)

- ☐ Extend `GeometryRef` to carry a `params: Y.Map<unknown>` for parametric
  primitives (`extruded-area-solid`, `swept-disk-solid`, `revolved-area-solid`,
  primitives).
- ☐ Bridge from Y.Map params → `ifc-lite-geometry` Rust kernel: on param
  change, recompute the mesh locally; emit content-hash; update
  `GeometryRef.geomId`.
- ☐ Validate determinism of the Rust kernel (open problem #5): bit-identical
  output across Linux/macOS/Windows for the same params. Add a CI matrix
  test.
- ☐ Fallback path: if the kernel reports non-deterministic output (e.g.
  `csgjs` ops), upload the mesh to the blob store instead.

### 3.3 Mesh geometry (§11.3)

- ☐ For imported / baked meshes, Y.Doc holds only `{ blobHash, versionVector
  }`. Replacing a mesh produces a new blob and bumps the version vector.
- ☐ Concurrent replacement keeps both blobs server-side and surfaces a
  conflict (see §3.5).

### 3.4 CSG-tree edits (§9.4 + open problem #4)

- ☐ Represent a CSG tree as `Y.Array<CSGOp>` with explicit reorder operations
  (drag-to-reorder UI). v1 keeps order-dependence visible; full CRDT-tree
  ordering deferred.
- ☐ Document the constraint clearly in package README so consumers know v1
  CSG composition is `Y.Array`-ordered, not topologically merged.

### 3.5 Conflict UX (§9.4, §9.7)

- ☐ `packages/collab/src/conflicts/detector.ts` — observes Y.Doc updates and
  flags concurrent geometry changes within a tunable window.
- ☐ `packages/collab/src/conflicts/ui-bridge.ts` — emits structured events
  the viewer/UI can render: ghost overlay of the "loser" position, "keep
  mine" button that generates a new transaction.
- ☐ Conflict badge component in `packages/viewer` (or `apps/web`) listening
  to `session.conflicts`.

### 3.6 Tests

- ☐ Determinism test: same params → same hash on every supported platform.
- ☐ Concurrent move scenario: two peers translate same wall; LWW wins; loser
  sees ghost; "keep mine" produces a follow-up op.
- ☐ Memory test: 100k entities with realistic geometry mix stays under 200
  MB for the Y.Doc (§15).

**Exit criteria:** a peer can move/resize a parametric wall and the mesh
appears identically on every other peer without any mesh bytes traversing
the websocket.

---

## 4. Phase v0.4 — Federation (4 weeks)

> **Status: ◐ Core + resolver interface landed.** `FederationSession`
> (`createFederationSession`) hosts N model-room `CollabSession`s plus
> a shared `_federation` Y.Doc for cross-model `FederationRecord`s
> (clash, RFI, view, BCF refs). Presence is project-scoped via the
> `_federation` doc per §10.2. **`FederationResolver`** is now a typed
> interface with `passThroughResolver` (default for IFCX UUID paths)
> and `createMapBackedResolver(table)` (for explicit
> `globalId → (modelId, localId)` lookups). The renderer's existing
> numeric-offset `FederationRegistry` can be wrapped to satisfy this
> interface without `@ifc-lite/collab` taking a hard dependency on the
> renderer (adapter snippet documented in `federation/resolver.ts`).
> Still pending: viewer-side federation-aware avatar rendering.

**Goal:** Multi-model rooms work; cross-model relationships and project-wide
presence behave per §10.

**Spec sections:** §10 federation in full.

- ☐ Room model upgrades from "1 model = 1 room" to "1 project = N model
  Y.Docs + 1 `_federation` Y.Doc." Update room IDs to `project-id/model-id`
  and `project-id/_federation`.
- ☐ `packages/collab/src/federation/` — manages multiple Y.Doc handles per
  session; one `FederationSession` aggregates them and exposes a single
  `presence` channel project-scoped per §10.2.
- ☐ Cross-model relationship records in `_federation` (clash issues, BCF
  topic refs, federation views) following the schema in §10.1.
- ☐ Hook into existing `FederationRegistry`: never reinvent globalId →
  modelId resolution; the CRDT layer only stores `{ modelId, globalId }`
  pairs and asks `FederationRegistry` to resolve per `AGENTS.md` §4.
- ☐ Awareness across federation: a user in `arch` and a user in `mep` see
  each other in the same peer list with model annotations on the avatar.
- ☐ Tests: scripted multi-model session with concurrent edits to `arch` and
  `mep`; verify both Y.Docs converge independently and `_federation` clash
  records sync correctly.

**Exit criteria:** open three federated models, drop a clash issue spanning
two of them, see a teammate hover the issue in the third model's viewport.

---

## 5. Phase v0.5 — Production (4 weeks)

> **Status: ◐ Operations stack landed.** `JsonlFileAuditSink` (size-based
> rotation), idle room unloading (`idleUnloadMs` plumbed end to end with
> a `sweepIdle()` method on `RoomManager` and tests), retention policy
> module (`planRetention` + `applyRetention` honoring `fullLogDays`,
> `snapshotsDays`, and `maxBytesPerRoom`). Auth, per-peer rate limiting,
> role-based write filtering, and the blob HTTP route are already in.
> **Server-driven IFCX snapshot worker** (`SnapshotWorker`) writes a
> per-room `.ifcx` to disk on a configurable interval. **Prometheus
> `/metrics`** endpoint serves text-format metrics for `collab_rooms`,
> `collab_room_peers`, `collab_updates_total`, and
> `collab_rejects_total{reason}`. **Anti-replay HMAC verifier**
> (`createReplayProtector`, open problem #8) ships as a pure verifier
> for opt-in deployments. Still pending: TLS termination wiring, S3 /
> Redis persistence backends, full bucketed histograms.

**Goal:** The server can be operated. Auth, persistence, observability, and
periodic IFCX snapshots are all real.

**Spec sections:** §8.2 authorization, §12.2 server persistence, §12.3 IFCX
snapshots (server-driven), §14 security & privacy (everything except E2E,
which is v1.0), §15 performance budget at scale.

### 5.1 Authorization (§8.2)

- ☐ JWT auth on connect; re-validation every 5 minutes.
- ☐ Roles: `viewer`, `commenter`, `editor`, `admin`. Server-side update
  filter rejects writes from insufficient roles.
- ☐ Optional per-section locks: server-side filter that drops mutations to
  `entity.geometryRef` from non-locked-section users (per §8.2). Defer
  per-storey/discipline granularity to v1.x (open problem #7).
- ☐ `audit-log.ts`: every server-mediated event logged with
  `(timestamp, user, room, op-type, op-hash)`; exportable to S3 / file.

### 5.2 Persistence at scale (§12.2)

- ☐ Pluggable persistence in `packages/collab-server/src/persistence/`:
  - `local-fs.ts` (existing, dev-only)
  - `s3.ts` (production)
  - `redis.ts` (optional, for `y-redis`-style multi-instance scale)
- ☐ Compaction policy: snapshot every 1000 updates or 5 minutes; truncate
  log to snapshot+tail.
- ☐ Cost-model policy decision (open problem #9): full log 90 days, then
  compacted snapshots only — encoded in a `retention.ts` module with config.

### 5.3 Server-driven IFCX snapshots (§12.3)

- ☐ `snapshot-worker.ts` exports `.ifcx` every N minutes (configurable per
  room) to S3 or filesystem. Layer breakdown per user (§12.3) is preserved.
- ☐ Snapshot job runs in a separate process so it can't block sync.

### 5.4 Observability

- ☐ Prometheus metrics (or OpenTelemetry) for: peers per room, updates per
  second, awareness msgs/sec, snapshot duration, persistence latency, room
  memory.
- ☐ Structured JSON logging with correlation IDs (room, user, request).
- ☐ Health, readiness, and liveness endpoints suitable for k8s.

### 5.5 Anti-replay (open problem #8)

- ☐ Per-update server-side validation: JWT on the connection plus an
  optional per-update HMAC. Drop replays via clientID + clock window.
- ☐ Document the threat model in `packages/collab-server/SECURITY.md`.

### 5.6 Hardening

- ☐ TLS 1.3 enforced (terminate at LB or in-process via Node TLS).
- ☐ At-rest AES-256 encryption for stored Y states + blobs (§14).
- ☐ Per-peer write budget hooks for v0.6 (open problem #10) — ship the knob
  unused now; turn it on in v0.6.
- ☐ Soak test (§18 long-haul stability): 24h with 5 peers, no leaks.

**Exit criteria:** deploy `collab-server` to a staging environment with TLS,
JWT auth, S3 persistence, periodic IFCX snapshots, and dashboards. Pass a
24h soak.

---

## 6. Phase v0.6 — MCP integration (2 weeks)

> **Status: ◐ Presence side landed.** `markAsAgent`, `agentIdentityFromMcp`,
> and the `AGENT_PALETTE` give MCP tool handlers a one-line way to
> publish agent presence with `(agent)` suffix and the `tool: 'edit'`
> marker. The server-side audit log already records every update with
> `(timestamp, user, room, op-type, op-hash)`, and `startCollabServer`
> already accepts a per-principal rate-limit function so service
> accounts can run with a tighter budget than humans. Still pending:
> the actual MCP tool-handler wiring inside `apps/api`.

**Goal:** AI agents become first-class peers. Their tool calls are CRDT
operations and they show up in awareness.

**Spec sections:** §16.4 MCP cross-spec integration, §10 (agent presence
inherits federation rules), open problem #10 (agent rate limiting).

- ☐ MCP server tool handlers (e.g. `entitySetProperty`) route through
  `ctx.session.bim.mutate.*` instead of writing to the in-memory store
  directly. The session is created with a service-account JWT.
- ☐ Agents publish presence with `tool: 'edit'`, a distinct avatar style,
  and a "(agent)" suffix on the display name.
- ☐ Per-peer write budget (open problem #10) is turned on for service
  accounts: tunable updates/sec ceiling; backpressure pushed back to MCP
  tools as a structured error so the agent retries gracefully.
- ☐ Audit log entries for agent-originated ops include the MCP tool name and
  invocation ID.
- ☐ Tests: scripted MCP session edits a wall while a human peer edits its
  Pset; both converge; UI shows the agent's avatar.

**Exit criteria:** Claude makes a property edit through MCP, a human in the
viewer sees the agent's cursor, the mutation, and the audit-log entry.

---

## 7. Phase v0.7 — Branching (6 weeks)

> **Status: ◐ Branching + differential composer landed.** `forkSession`
> snapshots the parent, seeds a sibling room, and stamps
> `meta.parentRoomId` / `branchName` / `forkedAt`. `mergeBranch`
> implements both `'ops'` and `'layer'` strategies with a `MergeReport`.
> **`extractMinimalLayer(doc, baseline, opts)`** now produces minimal
> IFCX layers expressing the diff between a baseline state vector and
> the current Y.Doc — entities created since baseline plus only the
> attribute / children / inherits keys that changed. Still pending:
> the Automerge history sidecar and the branch-tree visualization in
> apps/.

**Goal:** Users can fork a live document, edit privately, and merge back —
either as an IFCX layer or as a Y operation diff. Automerge sidecar holds
long-term history with branching/time-travel.

**Spec sections:** §4 (Yjs + Automerge split), §12.4 branching, open
problem #1 (layer ordering).

- ☐ `packages/collab/src/snapshot/branch.ts`:
  - `session.fork(name)` — snapshot Y.Doc → seed a new Y.Doc into a sibling
    room with `parentRoomId` metadata.
  - `session.mergeBranch(branch, strategy)` where strategy is
    `'layer'` (compose IFCX layers per §10) or `'ops'` (replay branch's Y
    update log on top of the parent room).
- ☐ Layer ordering (open problem #1): adopt strategy (b) — explicit "main"
  layer + per-user/per-branch "patch" layers. Encode the ordering rule in
  `snapshot/layers.ts`.
- ☐ Automerge sidecar in `packages/collab/src/history/automerge-sidecar.ts`:
  - At each Y.Doc snapshot, append the snapshot to an Automerge document
    that captures full history with branches and merge previews.
  - Expose `session.history.list()`, `.diff(a, b)`, `.preview(merge)`.
- ☐ UI: `apps/*` gets a branch tree visualization and a merge preview pane.
- ☐ Tests: fork → diverge → merge (both strategies) round-trips correctly.

**Exit criteria:** a user can fork "experiment-A", make changes, preview the
merge, accept it, and the audit log records the merge as a single event.

---

## 8. Phase v1.0 — GA (4 weeks)

> **Status: ◐ Schema migration + units + GDPR helpers landed.**
> `getSchemaVersion`, `setSchemaVersion`, `registerSchemaMigration`,
> `migrateSchema`, and `MIGRATION_ORIGIN` plumb the IFC4 → IFC4X3 →
> IFC5 migration story (open #2). **`convertEntityUnits(doc, from, to)`**
> walks every Pset and converts numeric `PropertyValue`s with a
> matching `unit` (length / area / volume / angle, open #3).
> **`convertValue(value, from, to)`** is exposed for one-shot
> conversions. **`exportAndLeave(session, opts)`** runs the GDPR
> "give-me-a-copy-and-forget-me" flow; **`redactAuthorMeta`** blanks
> per-entity `createdBy` / `lastEditedBy`. The actual IFC schema
> migrations, E2E encryption, and the long-tail unit families are
> still future work.

**Goal:** Production-ready with optional E2E encryption.

**Spec sections:** §14 (E2E option), §13 offline-first guarantees, §15
final perf budget, every open problem either resolved or explicitly deferred
in writing.

- ☐ Optional end-to-end encryption: client-side per-room key, server only
  routes ciphertext. Trade-off documented (server-side IFCX export
  unavailable without key escrow). Implement key rotation and a member-add
  rewrap protocol.
- ☐ GDPR flows (§14): hard-delete a room; user data export-then-leave.
- ☐ Polish offline-first edge cases (§13): "edits at risk" warnings when
  last-sync exceeds N minutes; explicit "unsynced edits" dialog on tab
  close.
- ☐ Schema-version migration UX (open problem #2): server-mediated lock,
  explicit prompt, unit-conversion convention for property unit changes
  (open problem #3).
- ☐ Final hardening pass: fuzz, dependency audit, threat model review,
  pen-test signoff.
- ☐ Docs: `docs/architecture/collab.md` (architecture deep dive),
  `docs/guide/collaboration.md` (user-facing).

**Exit criteria:** GA release of `@ifc-lite/collab@1.0.0` and
`@ifc-lite/collab-server@1.0.0` with changesets, CHANGELOGs, and migration
notes from any breaking changes since v0.1.

---

## 9. Cross-cutting concerns

### 9.1 Testing strategy (§18) — applies to every phase

- ☐ Convergence property tests: random concurrent edit traces, all peers end
  identical (Quickcheck-style).
- ☐ Performance harness in `packages/collab/test/perf.bench.ts` covering
  1k / 10k / 100k / 1M entities. Numbers checked against §15 budget on every
  PR via Turbo cache.
- ☐ Conflict scenarios: scripted scenarios for every class in §9.
- ☐ Network chaos: packet loss, delays, partitions; assert offline-first
  guarantees from §13.
- ☐ Cross-client soak: Tauri desktop + browser viewer + MCP server + CLI in
  one room.

### 9.2 Performance budget (§15) — non-negotiable per phase

| Metric | Target | Phase that first enforces it |
|---|---|---|
| Y.Doc memory @100k entities | <200 MB | v0.1 |
| Single-attr update size | <200 B | v0.1 |
| Sync latency LAN | <50 ms | v0.2 |
| Sync latency intercontinental | <300 ms | v0.2 |
| Awareness update rate | 30 Hz | v0.2 |
| Concurrent users / room | 50+ | v0.5 |
| IFCX snapshot @100k | <5 s | v0.5 |
| Cold load @100k | <3 s | v0.1 |

### 9.3 Open problems tracker (§20)

| # | Problem | Phase to land | Owner |
|---|---|---|---|
| 1 | Layer ordering vs CRDT op ordering | v0.7 (strategy b) | LT+ |
| 2 | Schema-version migrations during live session | v1.0 | LT+ |
| 3 | Property unit changes mid-session | v1.0 | LT+ |
| 4 | CSG-tree concurrent edits | v0.3 (ordered Y.Array); CRDT-tree deferred to v1.x | LT+ |
| 5 | Geometry-kernel determinism guarantees | v0.3 (CI matrix) | LT+ |
| 6 | Large-blob GC | v0.5 (epoch + refcount) | LT+ |
| 7 | Permissions granularity (per-storey) | v1.x | — |
| 8 | Replay attack surface | v0.5 | LT+ |
| 9 | Cost model for hosted service | v0.5 (retention.ts) | LT+ |
| 10 | AI agent rate limiting | v0.6 (knob in v0.5) | LT+ |

### 9.4 Risks & mitigations

- **Determinism risk** for the Rust geometry kernel (open #5). Mitigation:
  fail-closed — if a kernel build can't prove determinism, fall back to
  uploading mesh blobs.
- **Storage cost blowup** on hosted service. Mitigation: retention policy
  shipped at v0.5, dashboards in v0.5.
- **Yjs binary update format churn.** Pin major versions in `packages/collab`
  and gate upgrades behind dual-read tests against the recorded fixture.
- **Perf regressions** on 1M-entity models. Mitigation: bench-on-PR with
  Turbo, alert on >10% delta from baseline.

---

## 10. Phase status summary

| Phase | Status | ETA (cumulative) |
|---|---|---|
| v0.1 Foundation | ◐ planning | T+4w |
| v0.2 Multi-peer | ☐ | T+8w |
| v0.3 Geometry | ☐ | T+14w |
| v0.4 Federation | ☐ | T+18w |
| v0.5 Production | ☐ | T+22w |
| v0.6 MCP integration | ☐ | T+24w |
| v0.7 Branching | ☐ | T+30w |
| v1.0 GA | ☐ | T+34w |

Total: ~8 months from start to v1.0; v0.2 is the LinkedIn-demo milestone at
T+8w (per spec §19).

---

## 11. Glossary

- **Y.Doc** — a Yjs document; the live CRDT state container.
- **Layer (IFCX)** — an `.ifcx` file that adds to or overrides earlier
  layers when composed; spec §2 property #2.
- **Awareness** — out-of-band, last-write-wins-by-clock peer presence
  (`y-protocols/awareness`); not persisted.
- **Federation Registry** — existing `AGENTS.md` §4 component that resolves
  globalId ↔ modelId across loaded models. The CRDT layer integrates with
  it; never replaces it.
- **Branch (collab)** — a forked Y.Doc with `parentRoomId` metadata that can
  be merged back as an IFCX layer or a Y op-diff (§12.4).
