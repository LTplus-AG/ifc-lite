---
"@ifc-lite/collab": minor
"@ifc-lite/collab-server": minor
---

Continuing the v0.1 → v1.0 plan. Lands foundational pieces of v0.3
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
