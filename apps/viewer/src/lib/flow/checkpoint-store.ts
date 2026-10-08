/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flow review checkpoints in IndexedDB (#6923).
 *
 * A checkpoint is run state, not user content: it is not part of content
 * backups, and it lives in its own small database. Every write is a
 * compare-and-swap inside ONE readwrite transaction (read the row, compare
 * its revision, put the next one), which IndexedDB serialises across tabs,
 * so the shared `updateCheckpoint` from `@ifc-lite/flow` gives the same
 * single-consumption guarantee here that the CLI's lock file gives across
 * processes. Rows are validated with `parseCheckpoint` on every read: a
 * damaged or edited row is never resumed.
 */

import { parseCheckpoint, type CheckpointStore, type FlowCheckpoint, type StoredCheckpoint } from '@ifc-lite/flow/checkpoint';
import { IdbConnectionLifecycle } from '@/services/idb-connection';
import { requestValue, transactionDone } from '../storage/content-database.js';

const DATABASE = 'ifc-lite-flow-checkpoints';
const STORE = 'checkpoints';

interface Row { id: string; revision: number; checkpoint: unknown }

const connection = new IdbConnectionLifecycle('[Flow review]');

function open(): Promise<IDBDatabase> {
  return connection.open(() => new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: 'id' }); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Flow checkpoint storage is blocked by another tab'));
    request.onsuccess = () => resolve(request.result);
  }));
}

function decode(row: Row): StoredCheckpoint | null {
  try {
    return { checkpoint: parseCheckpoint(row.checkpoint), revision: row.revision };
  } catch (error) {
    console.warn('[Flow review] Ignoring an unreadable checkpoint', row.id, error);
    return null;
  }
}

async function allRows(): Promise<Row[]> {
  const tx = await connection.withConnection(open, (db) => db.transaction(STORE, 'readonly'));
  const [rows] = await Promise.all([requestValue(tx.objectStore(STORE).getAll() as IDBRequest<Row[]>), transactionDone(tx)]);
  return rows;
}

export const browserCheckpointStore: CheckpointStore = {
  async read(id) {
    const tx = await connection.withConnection(open, (db) => db.transaction(STORE, 'readonly'));
    const [row] = await Promise.all([requestValue(tx.objectStore(STORE).get(id) as IDBRequest<Row | undefined>), transactionDone(tx)]);
    return row ? decode(row) : null;
  },
  async write(checkpoint, expected) {
    const tx = await connection.withConnection(open, (db) => db.transaction(STORE, 'readwrite'));
    const store = tx.objectStore(STORE);
    const done = transactionDone(tx);
    const current = await requestValue(store.get(checkpoint.id) as IDBRequest<Row | undefined>);
    const swapped = (current?.revision ?? null) === expected;
    if (swapped) store.put({ id: checkpoint.id, revision: (current?.revision ?? 0) + 1, checkpoint } satisfies Row);
    await done;
    return swapped;
  },
};

/** Every readable checkpoint of one graph, newest first. */
export async function checkpointsOfGraph(graphId: string): Promise<FlowCheckpoint[]> {
  return (await allRows())
    .map(decode)
    .flatMap((stored) => (stored && stored.checkpoint.graphId === graphId ? [stored.checkpoint] : []))
    .sort((a, b) => b.createdAt - a.createdAt);
}
