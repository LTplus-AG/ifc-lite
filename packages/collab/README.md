# @ifc-lite/collab

Real-time collaborative BIM via CRDT on IFCX. Built on [Yjs](https://github.com/yjs/yjs).

> **Status: early (0.x).** Single- and multi-peer Y.Doc editing, IFCX
> seed/snapshot round-trip, IndexedDB persistence, undo manager, websocket
> provider, awareness/presence, conflict detection, per-user layer
> extraction, branching, federation, and end-to-end encryption helpers. See
> [Collaboration architecture](https://github.com/LTplus-AG/ifc-lite/blob/main/docs/architecture/collaboration.md)
> for the roadmap.

## Installation

```bash
npm install @ifc-lite/collab
```

## Why

IFC4/IFC4X3 (STEP) is a flat, ID-keyed, monolithic format that was designed
for export, not editing. IFCX (IFC5 JSON) is path-keyed and layer-composable
— every peer becomes a layer author and the composition rules are the merge
function. That makes it a natural fit for a CRDT.

## Quick start

```ts
import { createCollabSession } from '@ifc-lite/collab';
import { seedFromIfcx, snapshotToIfcx } from '@ifc-lite/collab/snapshot';

// 1. Seed a Y.Doc from an existing .ifcx file.
const buffer = await fetch('/model.ifcx').then((r) => r.arrayBuffer());
const session = await createCollabSession({
  roomId: 'project-abc/model.ifcx',
  user: { id: 'louis', name: 'Louis Trümpler', color: '#5b8def' },
  provider: 'indexeddb', // or 'websocket' for multi-peer (requires serverUrl)
});
seedFromIfcx(session.doc, buffer);

// 2. Edit through entity helpers.
import { setAttribute, createEntity } from '@ifc-lite/collab';
session.transact(() => {
  setAttribute(session.doc, 'wall-uuid', 'bsi::ifc::v5a::Pset_WallCommon::FireRating', 'EI60');
});

// 3. Awareness / presence.
session.presence.setSelection(['wall-uuid']);
session.presence.onUpdate((peers) => {
  // render avatars / cursors / selection outlines
});

// 4. Snapshot back to .ifcx whenever you want.
const ifcx = snapshotToIfcx(session.doc, { author: 'louis' });
```

## Public API

<!-- Reason: signature listing, not runnable code - bare member paths and `→` arrows. -->
<!-- docs-check: skip -->
```ts
createCollabSession(opts) → Promise<CollabSession>
session.doc            // Y.Doc
session.presence       // Presence (awareness wrapper)
session.whenSynced     // resolves once persistence / websocket sync completes
session.conflicts      // ConflictDetector observing this doc
session.undoController // UndoController (canUndo / canRedo)
session.status()       // websocket status, or 'memory' / 'indexeddb'
session.onStatus(listener)
session.seed(input)    // seed the Y.Doc from an .ifcx buffer or object
session.transact(fn)   // wrapper around ydoc.transact with our origin
session.undo()         // local-origin undo via Y.UndoManager
session.redo()
session.snapshot()     // → IfcxFile
session.captureBaseline()           // state vector to diff a user layer against
session.captureDocState()           // full doc state, the fork point for publishLayer
session.extractUserLayer(baseline)  // per-peer IFCX overlay layer
session.onConflict(listener)
session.onDispose(listener)
session.dispose()
```

Plus low-level helpers under `@ifc-lite/collab`:

- `createCollabDoc()` — produces a Y.Doc with the spec's three top-level maps.
- `createEntity / deleteEntity / setAttribute / setChild / setPropertyValue`
- `createRelationship / addTarget / removeTarget`
- `setGeometryRef / setGeometryParam`
- Placement: `setEntityPlacement` / `getEntityPlacement` (the `usd::xformop` attribute)
- CSG trees: `ensureCSGTree`, `getCSGOps`, `appendCSGOp`, `insertCSGOp`, `removeCSGOp`, `moveCSGOp`
- `seedFromIfcx / snapshotToIfcx / extractUserLayer`
- `createIndexedDbProvider / createWebSocketProvider`
- `createPresence` (awareness-backed presence)
- `createUndoManager`
- `createConflictDetector` / `createConflictUIBridge`
- `seedFromStep` - seed a Y.Doc from a STEP model
- `createWebRtcProvider` / `createMemoryProvider`
- Branching: `forkSession`, `mergeBranch`, `buildBranchTree`
- History sidecars: `attachHistorySidecar`, `MemoryHistorySidecar`, `AutomergeHistorySidecar`
- Rooms: `roomIdFor`, `parseRoomId`, `federationRoomId`; relay state: `fetchRoomStateVector`, `stateVectorCovers`
- Viewer presence: `mountPresenceInViewer`, `createPresenceOverlay`; agents: `markAsAgent`, `agentIdentityFromMcp`
- Privacy: `exportAndLeave`, `redactAuthorMeta`
- Federation: `createFederationSession`, model slots (`createModelSlot`, `listModelSlots`)
- End-to-end encryption: `generateRoomKey`, `deriveRoomKey`, `createKeyRing`, `encryptFrame` / `decryptFrame`
- Geometry blobs: `MemoryBlobStore`, `HttpBlobStore`, `createIndexedDbBlobStore`, `sweepBlobs`
- Annotations: `createAnnotation`, `updateAnnotation`, `deleteAnnotation`
- `bindMutationsToCollab` - wrap a `MutablePropertyView` so its writes mirror to a session
- `publishLayer` - freeze a draft doc into a published layer

Subpath entries: `@ifc-lite/collab/snapshot`, `@ifc-lite/collab/snapshot/worker`, `@ifc-lite/collab/awareness`, `@ifc-lite/collab/providers/indexeddb`, `@ifc-lite/collab/providers/websocket`.

## Conflict semantics

The CRDT never blocks or rolls back on conflict. Concurrent writes to the same
key converge deterministically to one value (Yjs last-write-wins), so every
peer ends up with the same document.

Conflict detection is advisory. `createConflictDetector(doc, { windowMs })`
(also wired into every session as `session.conflicts` and
`session.onConflict`) observes Y.Doc transactions and emits a structured
`ConflictEvent` when two writes land on the same target within `windowMs`
(default 750 ms). The `kind` is one of `attribute`, `pset-property`,
`quantity`, `hierarchy`, `geometry-blob`, `geometry-param`,
`relationship-target`, `concurrent-delete` or `concurrent-create`.
`createConflictUIBridge` turns the raw events into what a UI renders.

Type promotion (`promoteEntityType`, e.g. IfcWall to IfcCurtainWall) is a
delete plus a create, with `meta.previousPath` linking the new entity to the
old path.

## Docs

See the [ifc-lite docs](https://ifclite.dev/docs/). Pair with
[`@ifc-lite/collab-server`](https://www.npmjs.com/package/@ifc-lite/collab-server)
for multi-peer websocket sync.

## License

MPL-2.0
