# Real-Time Collaboration

IFClite supports real-time collaborative BIM editing. The `@ifc-lite/collab` package puts the model in a CRDT (a Yjs document mirroring the IFCX data model), so any number of peers can edit concurrently and converge without a central lock, online or offline. `@ifc-lite/collab-server` is the reference websocket sync server.

Collaboration is **IFCX/IFC5-canonical**: the CRDT schema mirrors the IFCX wire shape (path-keyed nodes, flat namespaced attributes, layer composition), so seeding from and snapshotting to IFCX are lossless, and every peer's edits form a composable IFCX layer. STEP-flavored IFC (IFC2X3/IFC4) is converted through IFCX to participate.

## Quick Start

```typescript
import { createCollabSession, setAttribute } from '@ifc-lite/collab';

const session = await createCollabSession({
  roomId: 'project-abc/model.ifcx',
  user: { id: 'louis', name: 'Louis', color: '#5b8def' },
  provider: 'indexeddb+websocket',   // 'memory' (default) | 'indexeddb' | 'websocket' | 'indexeddb+websocket'
  serverUrl: 'ws://localhost:1234',  // required for websocket providers
});

// Wait for persistence + websocket sync to complete
await session.whenSynced;

// Seed the shared document from an IFCX file (string, buffer, or parsed
// IfcxFile). ifcxContent is caller-provided, e.g.
// await fetch('model.ifcx').then(r => r.text())
session.seed(ifcxContent);

// Capture a baseline state vector now if you later want to extract just
// this peer's edits as a layer (see extractUserLayer below).
const baseline = session.captureBaseline();

// Make an edit; all peers see it in real time
session.transact(() => {
  setAttribute(session.doc, 'wall-uuid', 'bsi::ifc::v5a::Pset_WallCommon::FireRating', 'EI60');
});

// Live presence: selections and cursors of every peer
session.presence.setSelection(['wall-uuid']);
session.presence.onUpdate((peers) => {
  // render avatars / cursors / selection outlines
});

// Undo is scoped to your own edits only
session.undo();
session.redo();

// React to concurrent-edit conflicts (last-writer-wins has already resolved them)
const off = session.onConflict((conflict) => {
  console.log('conflict on', conflict);
});

// Snapshot the whole document back to IFCX
const file = session.snapshot();

// Or extract just this peer's edits as an IFCX layer. The baseline is the
// state vector captured with session.captureBaseline() before the edits.
const myLayer = session.extractUserLayer(baseline);

session.dispose();
```

Key points:

- `createCollabSession` is async and returns a `CollabSession`
- `session.whenSynced` is a promise property, not a method
- `session.presence` carries live cursors and selections between peers
- `token` in the options is forwarded to the server as a bearer token for authentication

## Running the Sync Server

The reference server is a plain Node websocket server with file persistence:

```sh
npx @ifc-lite/collab-server
# [collab-server] listening at ws://0.0.0.0:1234 (data: ./.collab-data)
```

Configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `COLLAB_PORT` | `1234` | Listen port |
| `COLLAB_HOST` | `0.0.0.0` | Bind address |
| `COLLAB_DATA_DIR` | `./.collab-data` | Room persistence directory |
| `COLLAB_MAX_ROOMS` | `1024` | Maximum loaded rooms |
| `COLLAB_METRICS_TOKEN` | unset | Token protecting the `/metrics` endpoint |

The server also exposes `/healthz`, Prometheus `/metrics`, and a content-addressed blob store under `/blobs/`.

For programmatic use, import `startCollabServer(opts)` from `@ifc-lite/collab-server`. Pluggable persistence backends include `FilePersistence`, `MemoryPersistence`, `S3Persistence`, and `RedisPersistence`. For production hardening (TLS, JWT authentication, per-role rate limits, path locks, JSONL audit logging), use `startSecureCollabServer` - see [Testing collab end-to-end](collab-testing.md#7-run-the-server-with-tls-locks-audit) for a full example.

## Beyond Basic Sync

These ship in `@ifc-lite/collab` today (mention-level; see the package README for details):

- **Branching and history** - `forkSession` forks a session into a branch, `mergeBranch` merges it back (op-based or layer-based strategies), and `buildBranchTree` reconstructs the branch graph from a history sidecar (`MemoryHistorySidecar` or `AutomergeHistorySidecar`, attached with `attachHistorySidecar`)
- **Federation** - `createFederationSession` composes one session per model plus a shared federation document for cross-model relationships
- **End-to-end encryption** - AES-GCM-256 per-room keys: `generateRoomKey` / `deriveRoomKey`, `encryptFrame` / `decryptFrame`, and `createKeyRing` for rotation
- **Privacy/GDPR** - `exportAndLeave` and `redactAuthorMeta`

## Try It: Two Runnable Demos

From the repository root:

```sh
pnpm collab:demo
```

Builds the packages, starts the sync server on `ws://localhost:1234` and a demo app on `http://localhost:5174`. Open it in two browser tabs: live peer cursors, shared selection, "Add wall" entity edits mirrored instantly, forced conflicts with keep-mine/accept-theirs, per-tab undo, and IFCX history snapshots.

```sh
pnpm collab:demo:3d
```

Same server, but serves the Three.js variant (`examples/threejs-collab`) on `http://localhost:5175`: every entity is a real 3D box whose position, size, rotation, and color are CRDT attributes. Drag a wall in tab A and it slides in tab B.

## Conflict Semantics

Concurrent edits converge automatically. Attribute writes resolve last-writer-wins by Lamport clock; the conflict detector then surfaces what happened through `session.onConflict` so the UI can offer keep-mine/accept-theirs. Geometry replacement keeps both candidates for explicit resolution, and delete-versus-edit prompts a restore. The full semantics table is in the [package README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/collab).

## Testing

For everything from unit suites to latency simulation, curl smoke tests, audit-log inspection, and the determinism harness, see the dedicated guide: [Testing @ifc-lite/collab end-to-end](collab-testing.md).

## Status

The collab stack is early (0.x). APIs are functional and tested, but expect breaking changes between minor versions.
