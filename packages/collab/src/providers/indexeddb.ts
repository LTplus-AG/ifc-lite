/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IndexedDB provider — local-first persistence per spec §12.1.
 *
 * Always-on: every CollabSession mirrors its Y.Doc to IndexedDB on each
 * update. Reload restores last state instantly; sync resumes from saved
 * state vector.
 *
 * Loaded lazily so non-browser environments (Node tests, server) don't
 * trip over the missing `indexedDB` global.
 */

import type * as Y from 'yjs';

export interface IndexedDbProvider {
  readonly roomId: string;
  /** Resolves once the local state has been loaded into the Y.Doc. */
  readonly whenSynced: Promise<void>;
  destroy(): void;
  /** Wipe persisted state for this room. */
  clearData(): Promise<void>;
}

export interface IndexedDbOptions {
  /** Override the IDB database name (defaults to `roomId`). */
  dbName?: string;
}

/**
 * Create an IndexedDB provider for `doc` keyed by `roomId`.
 *
 * Throws if `indexedDB` is unavailable. In Node tests, prefer to omit the
 * provider entirely or point the session at a `MemoryProvider`.
 */
export async function createIndexedDbProvider(
  doc: Y.Doc,
  roomId: string,
  options: IndexedDbOptions = {},
): Promise<IndexedDbProvider> {
  if (typeof indexedDB === 'undefined') {
    throw new Error(
      '@ifc-lite/collab: indexedDB is not available; createIndexedDbProvider requires a browser environment',
    );
  }
  // Dynamic import keeps `y-indexeddb` out of Node bundle paths.
  const { IndexeddbPersistence } = await import('y-indexeddb');
  const persistence = new IndexeddbPersistence(options.dbName ?? roomId, doc);

  const whenSynced = new Promise<void>((resolve) => {
    persistence.once('synced', () => resolve());
  });

  return {
    roomId,
    whenSynced,
    destroy: () => {
      persistence.destroy();
    },
    clearData: async () => {
      await persistence.clearData();
    },
  };
}

/**
 * In-memory provider. Useful for tests and ephemeral rooms. Functionally
 * a no-op; included so callers can ask for `provider: 'memory'` and still
 * get a `whenSynced` promise.
 */
export function createMemoryProvider(doc: Y.Doc, roomId: string): IndexedDbProvider {
  void doc;
  return {
    roomId,
    whenSynced: Promise.resolve(),
    destroy: () => {},
    clearData: async () => {},
  };
}
