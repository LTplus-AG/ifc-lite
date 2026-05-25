/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IndexedDB-backed implementation of the `FlavorStorage` interface
 * from `@ifc-lite/extensions`.
 *
 * Three object stores:
 *   - `flavors`       keyed by flavor id        → Flavor
 *   - `flavor-active` single-row key 'active'   → { id }
 *   - `flavor-snaps`  keyed by `<flavorId>@<seq>` → FlavorSnapshot
 *
 * The schema mirrors the in-memory storage in `@ifc-lite/extensions/flavor/storage.ts`
 * but persists across reloads. Snapshot cap of 10 per flavor is enforced
 * client-side (same as the in-memory impl).
 */

import type { Flavor, FlavorSnapshot, FlavorStorage } from '@ifc-lite/extensions';
import { ExtensionStorageQuotaError } from './idb-storage.js';

const DB_NAME = 'ifc-lite-flavors';
/** See idb-storage.ts for the migration policy. */
const DB_VERSION = 1;
const STORE_FLAVORS = 'flavors';
const STORE_ACTIVE = 'flavor-active';
const STORE_SNAPS = 'flavor-snaps';
const SNAPSHOT_CAP = 10;
const ACTIVE_KEY = 'active';

let dbPromise: Promise<IDBDatabase> | null = null;

interface SnapshotRow extends FlavorSnapshot {
  /** Compound key `<flavorId>@<seq>` so IDB can index without composite keys. */
  key: string;
  flavorId: string;
}

/**
 * Resolve once a readwrite transaction commits. Rejects on both
 * `error` AND `abort` — an aborted transaction fires neither
 * `oncomplete` nor `onerror`, so without the `onabort` branch the
 * returned promise would hang forever.
 */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Flavor IDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Flavor IDB transaction aborted.'));
  });
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

async function withQuotaGuard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isQuotaError(err)) {
      throw new ExtensionStorageQuotaError(operation, err);
    }
    throw err;
  }
}

export class IdbFlavorStorage implements FlavorStorage {
  async putFlavor(flavor: Flavor, reason?: string): Promise<void> {
    const db = await openDatabase();
    const previous = await this.getFlavor(flavor.id);
    if (previous) {
      await this.recordSnapshot(db, previous, reason);
    }
    await withQuotaGuard(`saving flavor "${flavor.id}"`, async () => {
      const tx = db.transaction(STORE_FLAVORS, 'readwrite');
      tx.objectStore(STORE_FLAVORS).put(flavor);
      await txDone(tx);
    });
  }

  async getFlavor(id: string): Promise<Flavor | undefined> {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FLAVORS, 'readonly');
      const req = tx.objectStore(STORE_FLAVORS).get(id);
      req.onsuccess = () => resolve((req.result as Flavor | undefined) ?? undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async listFlavors(): Promise<Flavor[]> {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FLAVORS, 'readonly');
      const req = tx.objectStore(STORE_FLAVORS).getAll();
      req.onsuccess = () => resolve((req.result as Flavor[] | undefined) ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteFlavor(id: string): Promise<void> {
    const db = await openDatabase();
    // Drop the flavor itself + cascade its snapshots.
    const tx = db.transaction([STORE_FLAVORS, STORE_SNAPS], 'readwrite');
    tx.objectStore(STORE_FLAVORS).delete(id);
    const snaps = tx.objectStore(STORE_SNAPS);
    const cursorReq = snaps.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const row = cursor.value as SnapshotRow;
      if (row.flavorId === id) cursor.delete();
      cursor.continue();
    };
    await txDone(tx);
    // If we deleted the active flavor, clear the pointer.
    const activeId = await this.getActiveId();
    if (activeId === id) await this.setActiveId(undefined);
  }

  async getActiveId(): Promise<string | undefined> {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_ACTIVE, 'readonly');
      const req = tx.objectStore(STORE_ACTIVE).get(ACTIVE_KEY);
      req.onsuccess = () => resolve((req.result as { id?: string } | undefined)?.id);
      req.onerror = () => reject(req.error);
    });
  }

  async setActiveId(id: string | undefined): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction(STORE_ACTIVE, 'readwrite');
    const store = tx.objectStore(STORE_ACTIVE);
    if (id === undefined) {
      store.delete(ACTIVE_KEY);
    } else {
      store.put({ key: ACTIVE_KEY, id });
    }
    await txDone(tx);
  }

  async listSnapshots(flavorId: string): Promise<FlavorSnapshot[]> {
    return (await this.listSnapshotRows(flavorId))
      .map(({ key, flavorId: _id, ...rest }) => rest as FlavorSnapshot);
  }

  async restoreSnapshot(flavorId: string, seq: number, reason?: string): Promise<Flavor | undefined> {
    const db = await openDatabase();
    const snap = await new Promise<SnapshotRow | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_SNAPS, 'readonly');
      const req = tx.objectStore(STORE_SNAPS).get(`${flavorId}@${seq}`);
      req.onsuccess = () => resolve(req.result as SnapshotRow | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!snap) return undefined;
    await this.putFlavor(snap.flavor, reason ?? 'restored from snapshot');
    return snap.flavor;
  }

  async clear(): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction([STORE_FLAVORS, STORE_ACTIVE, STORE_SNAPS], 'readwrite');
    tx.objectStore(STORE_FLAVORS).clear();
    tx.objectStore(STORE_ACTIVE).clear();
    tx.objectStore(STORE_SNAPS).clear();
    await txDone(tx);
  }

  /** Raw snapshot rows for a flavor, newest seq first. */
  private async listSnapshotRows(flavorId: string): Promise<SnapshotRow[]> {
    const db = await openDatabase();
    const all = await new Promise<SnapshotRow[]>((resolve, reject) => {
      const tx = db.transaction(STORE_SNAPS, 'readonly');
      const req = tx.objectStore(STORE_SNAPS).getAll();
      req.onsuccess = () => resolve((req.result as SnapshotRow[] | undefined) ?? []);
      req.onerror = () => reject(req.error);
    });
    return all
      .filter((s) => s.flavorId === flavorId)
      .sort((a, b) => b.seq - a.seq);
  }

  private async recordSnapshot(
    db: IDBDatabase,
    flavor: Flavor,
    reason: string | undefined,
  ): Promise<void> {
    // Derive the next seq from the snapshots already persisted for
    // this flavor. A reload-resettable in-memory counter would restart
    // at 1 and overwrite existing `<flavorId>@1`, `@2`, … rows.
    const existing = await this.listSnapshotRows(flavor.id);
    const seq = existing.reduce((max, s) => Math.max(max, s.seq), 0) + 1;
    const row: SnapshotRow = {
      key: `${flavor.id}@${seq}`,
      flavorId: flavor.id,
      seq,
      capturedAt: new Date().toISOString(),
      flavor,
      reason,
    };
    const putTx = db.transaction(STORE_SNAPS, 'readwrite');
    putTx.objectStore(STORE_SNAPS).put(row);
    await txDone(putTx);
    // Enforce cap: keep newest SNAPSHOT_CAP rows per flavor.
    const all = [row, ...existing];
    if (all.length > SNAPSHOT_CAP) {
      const toDrop = all.slice(SNAPSHOT_CAP);
      const dropTx = db.transaction(STORE_SNAPS, 'readwrite');
      const store = dropTx.objectStore(STORE_SNAPS);
      for (const s of toDrop) store.delete(`${flavor.id}@${s.seq}`);
      await txDone(dropTx);
    }
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FLAVORS)) {
        db.createObjectStore(STORE_FLAVORS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_ACTIVE)) {
        db.createObjectStore(STORE_ACTIVE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_SNAPS)) {
        db.createObjectStore(STORE_SNAPS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Flavor IDB open blocked by another tab.'));
  });
  return dbPromise;
}
