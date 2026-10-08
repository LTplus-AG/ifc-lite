/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IdbConnectionLifecycle } from '../../services/idb-connection.js';
import { sameReportEvidence } from '../flow/report-provenance.js';
import { announceContentChange } from './content-events.js';
import { contentImportIdentity } from './content-import-identity.js';
import { CONTENT_POLICIES, isContentKind, type ContentKind } from './content-kinds.js';

const CONTENT_DATABASE = 'ifc-lite-user-content';
export type ContentFailure = 'quota' | 'unavailable' | 'conflict' | 'invalid';
export type ContentResult = { ok: true; revision: number } | { ok: false; reason: ContentFailure };
export interface ContentRow {
  kind: ContentKind;
  id: string;
  version: 1;
  revision: number;
  createdAt: number;
  modifiedAt: number;
  deleted: boolean;
  payload: unknown;
  /** Source fingerprint makes repeated conflict imports idempotent, even after deletion. */
  importedFrom?: string;
}
export interface RecoveryRow { key: string; raw: string; createdAt: number }
export interface MigrationRow { key: string; originalKey: string | null; recovered: boolean }

const connection = new IdbConnectionLifecycle('[User content]');
let lastCreatedAt = 0;
export function contentCreatedAt(): number {
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1 / 1024);
  return lastCreatedAt;
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('User content transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('User content transaction failed'));
  });
}

export function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function contentFailure(error: unknown): ContentFailure {
  console.warn('[User content] Storage operation failed', error);
  return error instanceof Error && ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(error.name)
    ? 'quota' : 'unavailable';
}

function openContentDatabase(): Promise<IDBDatabase> {
  return connection.open(() => new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const request = indexedDB.open(CONTENT_DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const items = db.createObjectStore('items', { keyPath: ['kind', 'id'] });
      items.createIndex('kind', 'kind');
      db.createObjectStore('migrations', { keyPath: 'key' });
      db.createObjectStore('recovery', { keyPath: 'key' });
    };
    // Never delete/recreate user data, including when an upgrade is blocked.
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Database upgrade blocked by another tab; close it and retry'));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
  }));
}

export function contentTransaction(stores: string | string[], mode: IDBTransactionMode): Promise<IDBTransaction> {
  return connection.withConnection(openContentDatabase, db => db.transaction(stores, mode));
}

export async function readContentRows(kind: ContentKind): Promise<ContentRow[]> {
  const tx = await contentTransaction('items', 'readonly');
  const done = transactionDone(tx);
  const values = requestValue(tx.objectStore('items').index('kind').getAll(kind)) as Promise<ContentRow[]>;
  const [rows] = await Promise.all([values, done]);
  return rows.sort((left, right) => left.createdAt - right.createdAt);
}

export interface ContentWrite { kind: ContentKind; id: string; payload: unknown; expected: number }
export type ContentBatchResult = { ok: true; rows: ContentRow[] } | { ok: false; reason: ContentFailure };

/** All revisions and evidence policies are checked before any write in this transaction. */
export async function writeContentBatch(input: readonly ContentWrite[]): Promise<ContentBatchResult> {
  if (!input.length || input.length > 100) return { ok: false, reason: 'invalid' };
  const identities = new Set<string>();
  for (const item of input) {
    const identity = JSON.stringify([item.kind, item.id]);
    if (!isContentKind(item.kind) || typeof item.id !== 'string' || !item.id.length || identities.has(identity)
      || !Number.isSafeInteger(item.expected) || item.expected < 0 || item.expected >= Number.MAX_SAFE_INTEGER) {
      return { ok: false, reason: 'invalid' };
    }
    identities.add(identity);
  }
  // Freeze the reviewed effect before opening an asynchronous database transaction.
  let writes: ContentWrite[];
  try { writes = structuredClone([...input]); }
  catch (error) { console.warn('[User content] Non-portable content transaction refused', error); return { ok: false, reason: 'invalid' }; }
  let failed: ContentFailure | null = null;
  try {
    const tx = await contentTransaction('items', 'readwrite');
    const done = transactionDone(tx), store = tx.objectStore('items');
    const rows: ContentRow[] = [];
    let remaining = writes.length;
    writes.forEach((item, index) => {
      const request = store.get([item.kind, item.id]);
      request.onsuccess = () => {
        try {
          const current = request.result as ContentRow | undefined;
          if ((current?.revision ?? 0) !== item.expected || current?.deleted && item.payload !== null) failed ??= 'conflict';
          if (CONTENT_POLICIES[item.kind].immutableEvidence && current && item.payload !== null) {
            const withoutName = (value: unknown): unknown => {
              if (!value || typeof value !== 'object') return value;
              const { name: _name, ...evidence } = value as Record<string, unknown>;
              return evidence;
            };
            if (!sameReportEvidence(withoutName(current.payload), withoutName(item.payload))) failed ??= 'invalid';
          }
          const importedFrom = current?.importedFrom ?? (!current ? contentImportIdentity(item.kind, item.id) : undefined);
          rows[index] = { kind: item.kind, id: item.id, version: 1, revision: item.expected + 1,
            createdAt: current?.createdAt ?? contentCreatedAt(), modifiedAt: Date.now(), deleted: item.payload === null,
            payload: item.payload, ...(importedFrom ? { importedFrom } : {}) };
          if (--remaining === 0 && !failed) for (const row of rows) store.put(row);
        } catch (error) {
          failed = contentFailure(error);
          tx.abort();
        }
      };
    });
    await done;
    if (failed) return { ok: false, reason: failed };
    for (const kind of new Set(writes.map(item => item.kind))) announceContentChange(kind);
    return { ok: true, rows };
  } catch (error) { return { ok: false, reason: failed ?? contentFailure(error) }; }
}

/** Existing single-item callers share the batch transaction and tombstone policy. */
export async function writeContent(kind: ContentKind, id: string, payload: unknown, expected: number): Promise<ContentResult> {
  const result = await writeContentBatch([{ kind, id, payload, expected }]);
  return result.ok ? { ok: true, revision: result.rows[0].revision } : result;
}
