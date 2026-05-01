/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CollabSession — the public façade documented in spec §16.2.
 *
 * Glues the Y.Doc, providers, presence, undo, and conflict detector into
 * a single object. Callers don't touch the underlying libraries unless
 * they want to.
 */

import type { IfcxFile } from '@ifc-lite/ifcx';
import * as Y from 'yjs';
import { createCollabDoc, LOCAL_ORIGIN } from './doc/schema.js';
import {
  createConflictDetector,
  type ConflictDetector,
  type ConflictListener,
} from './conflicts/detector.js';
import { createPresence, type Presence, type UserIdentity } from './awareness/presence.js';
import {
  createIndexedDbProvider,
  createMemoryProvider,
  type IndexedDbProvider,
} from './providers/indexeddb.js';
import {
  createWebSocketProvider,
  type WebSocketProvider,
  type WebSocketStatus,
} from './providers/websocket.js';
import { snapshotToIfcx, type SnapshotOptions } from './snapshot/to-ifcx.js';
import { seedFromIfcx, type IfcxInput, type SeedOptions } from './snapshot/from-ifcx.js';
import {
  captureBaseline as captureBaselineSV,
  extractUserLayer as extractLayerForClient,
} from './snapshot/layers.js';
import { createUndoManager, type UndoController } from './undo.js';

export type ProviderKind = 'memory' | 'indexeddb' | 'websocket' | 'indexeddb+websocket';

export interface CollabSessionOptions {
  roomId: string;
  user: UserIdentity;
  /**
   * Choice of network/persistence stack. `'indexeddb+websocket'` runs both
   * (recommended for browser deployments). `'memory'` is for tests and
   * ephemeral rooms.
   */
  provider?: ProviderKind;
  /** Required when `provider` involves websocket. */
  serverUrl?: string;
  /** Bearer token forwarded to the websocket server. */
  token?: string;
  /** Override the IDB database name. */
  dbName?: string;
  /** Auto-connect the websocket on construction (default true). */
  connect?: boolean;
  /** Existing Y.Doc to bind to. Defaults to a fresh `createCollabDoc()`. */
  doc?: Y.Doc;
  /** Ws polyfill (e.g. `ws` package in Node tests). */
  WebSocketPolyfill?: unknown;
  /** Presence config knobs. */
  presence?: { updateRateHz?: number; staleAfterMs?: number };
}

export interface CollabSession {
  readonly roomId: string;
  readonly doc: Y.Doc;
  readonly clientId: number;
  readonly presence: Presence;
  readonly undoController: UndoController;
  readonly conflicts: ConflictDetector;
  readonly provider: ProviderKind;
  /** Resolves once both persistence and (if applicable) websocket sync have completed. */
  readonly whenSynced: Promise<void>;
  status(): WebSocketStatus | 'memory' | 'indexeddb';
  onStatus(listener: (s: WebSocketStatus | 'memory' | 'indexeddb') => void): () => void;
  /** Seed this session's Y.Doc from an IFCX file. */
  seed(input: IfcxInput, options?: SeedOptions): IfcxFile;
  /** Snapshot the current state to an IFCX object. */
  snapshot(options?: SnapshotOptions): IfcxFile;
  /** Capture a baseline state vector for later layer extraction. */
  captureBaseline(): Uint8Array;
  /** Extract a per-user layer (defaults to *this* peer). */
  extractUserLayer(baseline: Uint8Array, clientId?: number, snapshot?: SnapshotOptions): IfcxFile;
  /** Wrap edits in a Yjs transaction tagged with our local origin. */
  transact<T>(fn: () => T): T;
  /** Local-origin undo via Y.UndoManager. */
  undo(): boolean;
  redo(): boolean;
  onConflict(listener: ConflictListener): () => void;
  dispose(): void;
}

export async function createCollabSession(opts: CollabSessionOptions): Promise<CollabSession> {
  const doc = opts.doc ?? createCollabDoc();

  const presence = createPresence(doc, opts.presence ?? {});
  presence.setUser(opts.user);
  presence.setStatus('active');

  const undoController = createUndoManager(doc);
  const conflicts = createConflictDetector(doc);

  const providerKind: ProviderKind = opts.provider ?? 'memory';
  let idb: IndexedDbProvider | undefined;
  let ws: WebSocketProvider | undefined;

  let currentStatus: WebSocketStatus | 'memory' | 'indexeddb' =
    providerKind === 'memory' ? 'memory' : 'indexeddb';
  const statusListeners = new Set<(s: WebSocketStatus | 'memory' | 'indexeddb') => void>();
  const setStatus = (s: WebSocketStatus | 'memory' | 'indexeddb') => {
    if (s === currentStatus) return;
    currentStatus = s;
    statusListeners.forEach((l) => l(s));
  };

  const synced: Promise<void>[] = [];

  if (providerKind === 'indexeddb' || providerKind === 'indexeddb+websocket') {
    idb = await createIndexedDbProvider(doc, opts.roomId, { dbName: opts.dbName });
    synced.push(idb.whenSynced);
  } else if (providerKind === 'memory') {
    idb = createMemoryProvider(doc, opts.roomId);
    synced.push(idb.whenSynced);
  }

  if (providerKind === 'websocket' || providerKind === 'indexeddb+websocket') {
    if (!opts.serverUrl) {
      throw new Error('@ifc-lite/collab: serverUrl is required for websocket providers');
    }
    ws = await createWebSocketProvider(doc, opts.roomId, opts.serverUrl, {
      WebSocketPolyfill: opts.WebSocketPolyfill,
      token: opts.token,
      awareness: presence.awareness,
      connect: opts.connect ?? true,
    });
    ws.onStatus(setStatus);
    synced.push(ws.whenSynced);
  }

  const session: CollabSession = {
    roomId: opts.roomId,
    doc,
    clientId: doc.clientID,
    presence,
    undoController,
    conflicts,
    provider: providerKind,
    whenSynced: Promise.all(synced).then(() => undefined),
    status: () => currentStatus,
    onStatus(listener) {
      statusListeners.add(listener);
      listener(currentStatus);
      return () => statusListeners.delete(listener);
    },
    seed(input, options) {
      return seedFromIfcx(doc, input, options);
    },
    snapshot(options) {
      return snapshotToIfcx(doc, options);
    },
    captureBaseline() {
      return captureBaselineSV(doc);
    },
    extractUserLayer(baseline, clientId, snapshot) {
      return extractLayerForClient(doc, baseline, {
        clientId: clientId ?? doc.clientID,
        snapshot,
      });
    },
    transact(fn) {
      let result!: ReturnType<typeof fn>;
      doc.transact(() => {
        result = fn();
      }, LOCAL_ORIGIN);
      return result;
    },
    undo() {
      return undoController.undo();
    },
    redo() {
      return undoController.redo();
    },
    onConflict(listener) {
      return conflicts.onConflict(listener);
    },
    dispose() {
      conflicts.destroy();
      undoController.destroy();
      presence.dispose();
      if (ws) ws.destroy();
      if (idb) idb.destroy();
    },
  };

  return session;
}
