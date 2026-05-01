# @ifc-lite/collab

Real-time collaborative BIM via CRDT on IFCX. Built on [Yjs](https://github.com/yjs/yjs).

> **Status: v0.1 Foundation.** Single- and multi-peer Y.Doc editing, IFCX
> seed/snapshot round-trip, IndexedDB persistence, undo manager, websocket
> provider, awareness/presence types, conflict detection. See
> [`docs/architecture/collab-plan.md`](../../docs/architecture/collab-plan.md)
> for the full v0.1 → v1.0 roadmap.

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
  provider: 'indexeddb', // or 'websocket' for multi-peer
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

```ts
createCollabSession(opts) → CollabSession
session.doc           // Y.Doc
session.presence      // Presence (awareness wrapper)
session.transact(fn)  // wrapper around ydoc.transact with our origin
session.undo()        // local-origin undo via Y.UndoManager
session.redo()
session.snapshot()    // → IfcxFile
session.dispose()
```

Plus low-level helpers under `@ifc-lite/collab`:

- `createCollabDoc()` — produces a Y.Doc with the spec's three top-level maps.
- `createEntity / deleteEntity / setAttribute / setChild / setPropertyValue`
- `createRelationship / addTarget / removeTarget`
- `setGeometryRef / setGeometryParam`
- `seedFromIfcx / snapshotToIfcx / extractUserLayer`
- `createIndexedDbProvider / createWebSocketProvider`
- `createPresence` (awareness-backed presence)
- `createUndoManager`
- `createConflictDetector`

## Conflict semantics

See spec §9 for the full conflict policy. In short:

| Conflict | Resolution |
|---|---|
| Concurrent attribute writes | Last-write-wins by Lamport clock |
| Concurrent Pset property writes | LWW per property |
| Hierarchy moves (e.g. wall → storey) | LWW on the containment relationship; loser is notified |
| Concurrent geometry replace (mesh) | Both versions kept; conflict surfaced |
| Type promotion (e.g. IfcWall → IfcCurtainWall) | Server-mediated lock required |
| Concurrent delete + edit | Edit applies to tombstoned entity; user prompted to restore |

The `createConflictDetector` helper observes Y.Doc updates and emits
structured events that the viewer (or any UI) can render.

## License

MPL-2.0
