/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IdbConnectionLifecycle } from '../../services/idb-connection.js';
import { sameReportEvidence } from '../flow/report-provenance.js';
import { announceContentChange } from './content-events.js';
import { contentImportIdentity } from './content-import-identity.js';

const CONTENT_DATABASE = 'ifc-lite-user-content';
export type ContentKind = 'validation' | 'comparison' | 'document';
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

/** Revision check and write share a transaction, including deletion tombstones. */
export async function writeContent(kind: ContentKind, id: string, payload: unknown, expected: number): Promise<ContentResult> {
  try {
    const tx = await contentTransaction('items', 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore('items');
    let result: ContentResult = { ok: false, reason: 'conflict' };
    const request = store.get([kind, id]);
    request.onsuccess = () => {
      const current = request.result as ContentRow | undefined;
      if ((current?.revision ?? 0) !== expected || (current?.deleted && payload !== null)) return;
      if (kind !== 'document' && current && payload !== null) {
        const withoutName = (value: unknown): unknown => {
          if (!value || typeof value !== 'object') return value;
          const { name: _name, ...evidence } = value as Record<string, unknown>;
          return evidence;
        };
        if (!sameReportEvidence(withoutName(current.payload), withoutName(payload))) {
          result = { ok: false, reason: 'invalid' }; return;
        }
      }
      const revision = expected + 1;
      // Only a new, revision-checked identity may consume staged import provenance.
      const importedFrom = current?.importedFrom ?? (!current ? contentImportIdentity(kind, id) : undefined);
      store.put({ kind, id, version: 1, revision, createdAt: current?.createdAt ?? contentCreatedAt(),
        modifiedAt: Date.now(), deleted: payload === null, payload,
        ...(importedFrom ? { importedFrom } : {}) } satisfies ContentRow);
      result = { ok: true, revision };
    };
    await done;
    if (result.ok) announceContentChange(kind);
    return result;
  } catch (error) { return { ok: false, reason: contentFailure(error) }; }
}
