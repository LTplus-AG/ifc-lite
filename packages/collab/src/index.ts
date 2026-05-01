/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/collab — Real-time collaborative BIM via CRDT on IFCX.
 *
 * See `docs/architecture/collab-plan.md` for the v0.1 → v1.0 roadmap.
 */

// Doc model
export * from './doc/schema.js';
export * from './doc/entity.js';
export * from './doc/relationship.js';
export * from './doc/geometry.js';

// Snapshot / IFCX bridge
export * from './snapshot/index.js';

// Providers
export {
  createIndexedDbProvider,
  createMemoryProvider,
  type IndexedDbProvider,
  type IndexedDbOptions,
} from './providers/indexeddb.js';
export {
  createWebSocketProvider,
  type WebSocketProvider,
  type WebSocketProviderOptions,
  type WebSocketStatus,
} from './providers/websocket.js';

// Sync helpers
export * from './sync/room.js';

// Awareness / presence
export * from './awareness/index.js';

// Undo / redo
export { createUndoManager, UNDO_ORIGIN, type UndoOptions, type UndoController } from './undo.js';

// Conflict detection
export * from './conflicts/index.js';

// Geometry: blob store + CSG-tree CRDT
export * from './geometry/index.js';

// Federation
export * from './federation/index.js';

// Branching (v0.7 starter)
export * from './branch/index.js';

// Privacy / GDPR helpers (v1.0)
export * from './privacy.js';

// Perf / benchmark helpers (v0.2)
export * from './perf/index.js';

// Top-level session façade
export {
  createCollabSession,
  type CollabSession,
  type CollabSessionOptions,
  type ProviderKind,
} from './session.js';
