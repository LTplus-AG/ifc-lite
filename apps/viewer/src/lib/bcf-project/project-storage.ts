/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IdbConnectionLifecycle } from '../../services/idb-connection.js';
import { contentFailure, requestValue, transactionDone, type ContentFailure } from '../storage/content-database.js';

const database = 'ifc-lite-bcf-project';
const store = 'project';
const key = 'open';
const connection = new IdbConnectionLifecycle('[BCF autosave]');

interface Slot { revision: string; data: string | null }

function transaction(mode: IDBTransactionMode): Promise<IDBTransaction> {
  return connection.withConnection(() => connection.open(() => new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(store);
    request.onerror = () => reject(request.error);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error('BCF autosave database upgrade blocked'));
    };
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
  })), db => db.transaction(store, mode));
}

function isSlot(value: unknown): value is Slot {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<Slot>;
  return typeof row.revision === 'string' && row.revision.length > 0 && (row.data === null || typeof row.data === 'string');
}

export async function readBcfSlot(): Promise<Slot | 'unreadable' | null> {
  const tx = await transaction('readonly');
  const [value] = await Promise.all([requestValue(tx.objectStore(store).get(key)) as Promise<unknown>, transactionDone(tx)]);
  return value === undefined ? null : isSlot(value) ? value : 'unreadable';
}

export async function writeBcfSlot(data: string | null, expected: string | null):
Promise<{ ok: true; revision: string } | { ok: false; reason: ContentFailure }> {
  try {
    const revision = crypto.randomUUID();
    const tx = await transaction('readwrite');
    const items = tx.objectStore(store);
    const done = transactionDone(tx);
    const read = items.get(key);
    let refused: ContentFailure | undefined;
    read.onsuccess = () => {
      const current: unknown = read.result;
      if (current !== undefined && !isSlot(current)) { refused = 'invalid'; return; }
      if ((current?.revision ?? null) !== expected) { refused = 'conflict'; return; }
      try {
        // The empty slot keeps a new revision so a stale tab cannot recreate a closed project.
        items.put({ revision, data } satisfies Slot, key);
      } catch (error) {
        refused = contentFailure(error);
        tx.abort();
      }
    };
    await done;
    return refused ? { ok: false, reason: refused } : { ok: true, revision };
  } catch (error) { return { ok: false, reason: contentFailure(error) }; }
}
