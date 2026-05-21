/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IndexedDB-backed persistence for the action log and audit log.
 *
 * Both logs are append-only ring buffers in memory. This module mirrors
 * each appended event into IDB so the history survives reloads, and
 * loads the prior snapshot on app boot via the logs' `hydrate()`
 * methods.
 *
 * Two object stores:
 *   - `action-events`  keyed by `seq` → ActionEvent
 *   - `audit-events`   keyed by `seq` → AuditEvent
 *
 * Writes are debounced (250 ms) to keep the IDB hit rate down during
 * fast bursts; the in-memory log is the source of truth between
 * debounce flushes.
 */

import type { ActionEvent, AuditEvent } from '@ifc-lite/extensions';

const DB_NAME = 'ifc-lite-extension-logs';
const DB_VERSION = 1;
const STORE_ACTION = 'action-events';
const STORE_AUDIT = 'audit-events';
const DEBOUNCE_MS = 250;

let dbPromise: Promise<IDBDatabase> | null = null;

export class IdbLogStorage {
  private actionPending: ActionEvent[] = [];
  private auditPending: AuditEvent[] = [];
  private actionTimer: ReturnType<typeof setTimeout> | null = null;
  private auditTimer: ReturnType<typeof setTimeout> | null = null;

  async loadActions(): Promise<ActionEvent[]> {
    return loadAll<ActionEvent>(STORE_ACTION);
  }

  async loadAudit(): Promise<AuditEvent[]> {
    return loadAll<AuditEvent>(STORE_AUDIT);
  }

  /** Queue an action event for persistence; flushes after DEBOUNCE_MS. */
  appendAction(event: ActionEvent): void {
    this.actionPending.push(event);
    if (this.actionTimer) clearTimeout(this.actionTimer);
    this.actionTimer = setTimeout(() => {
      void this.flushActions();
    }, DEBOUNCE_MS);
  }

  /** Queue an audit event for persistence; flushes after DEBOUNCE_MS. */
  appendAudit(event: AuditEvent): void {
    this.auditPending.push(event);
    if (this.auditTimer) clearTimeout(this.auditTimer);
    this.auditTimer = setTimeout(() => {
      void this.flushAudit();
    }, DEBOUNCE_MS);
  }

  /** Wipe the action store (called when the user clears the log). */
  async clearActions(): Promise<void> {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ACTION, 'readwrite');
      tx.objectStore(STORE_ACTION).clear();
      bindTx(tx, resolve, reject);
    });
    this.actionPending = [];
  }

  async clearAudit(): Promise<void> {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_AUDIT, 'readwrite');
      tx.objectStore(STORE_AUDIT).clear();
      bindTx(tx, resolve, reject);
    });
    this.auditPending = [];
  }

  /**
   * Flush both pending batches immediately and cancel the debounce
   * timers. Call on host teardown / before reload so events appended
   * within the last DEBOUNCE_MS window aren't lost and the timers
   * don't leak.
   */
  async flush(): Promise<void> {
    if (this.actionTimer) { clearTimeout(this.actionTimer); this.actionTimer = null; }
    if (this.auditTimer) { clearTimeout(this.auditTimer); this.auditTimer = null; }
    await Promise.all([this.flushActions(), this.flushAudit()]);
  }

  private async flushActions(): Promise<void> {
    if (this.actionPending.length === 0) return;
    const batch = this.actionPending;
    this.actionPending = [];
    try {
      const db = await openDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_ACTION, 'readwrite');
        const store = tx.objectStore(STORE_ACTION);
        for (const event of batch) store.put(event);
        bindTx(tx, resolve, reject);
      });
    } catch (err) {
      console.warn('[IdbLogStorage] action flush failed:', err);
    }
  }

  private async flushAudit(): Promise<void> {
    if (this.auditPending.length === 0) return;
    const batch = this.auditPending;
    this.auditPending = [];
    try {
      const db = await openDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_AUDIT, 'readwrite');
        const store = tx.objectStore(STORE_AUDIT);
        for (const event of batch) store.put(event);
        bindTx(tx, resolve, reject);
      });
    } catch (err) {
      console.warn('[IdbLogStorage] audit flush failed:', err);
    }
  }
}

/**
 * Settle a readwrite transaction. The `abort` branch matters: an
 * aborted transaction fires neither `complete` nor `error`, so the
 * promise would otherwise hang forever.
 */
function bindTx(tx: IDBTransaction, resolve: () => void, reject: (e: unknown) => void): void {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error('Log IDB transaction failed.'));
  tx.onabort = () => reject(tx.error ?? new Error('Log IDB transaction aborted.'));
}

async function loadAll<T>(store: string): Promise<T[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(((req.result as T[] | undefined) ?? []));
    req.onerror = () => reject(req.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ACTION)) {
        db.createObjectStore(STORE_ACTION, { keyPath: 'seq' });
      }
      if (!db.objectStoreNames.contains(STORE_AUDIT)) {
        db.createObjectStore(STORE_AUDIT, { keyPath: 'seq' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Log IDB open blocked by another tab.'));
  });
  return dbPromise;
}
