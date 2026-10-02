/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sameReportEvidence } from '../flow/report-provenance.js';
import { newSavedReport, type SavedValidationReport } from '../validation/reports/history.js';
import { validationContent } from '../validation/reports/persistence.js';
import { comparisonContent } from '../compare/savedComparisonPersistence.js';
import type { SavedComparison } from '../compare/savedComparisonSchema.js';
import { documentContent, parseDocumentFile } from '../document/persistence.js';
import type { DocumentSpec } from '../document/types.js';
import { computeFullSourceHash } from '../../utils/sourceContentHash.js';
import { contentTransaction, contentCreatedAt, transactionDone, requestValue, type ContentRow, type MigrationRow, type RecoveryRow } from './content-database.js';
import { announceContentChange } from './content-events.js';
import { readLegacyOriginals } from './content-migration.js';
import { rebindContentDocument } from './content-backup-references.js';
import { BACKUP_DRAFT_PREFIX, draftRecoveryRows, forgetContentDrafts, mergeContentDrafts, parseContentDrafts,
  pendingContentDrafts, stageContentDrafts, type ContentDraftEvidence } from './content-backup-drafts.js';

export interface ContentLibraries {
  validation: SavedValidationReport[];
  comparison: SavedComparison[];
  document: DocumentSpec[];
}
export interface ContentBackup {
  version: 1;
  exportedAt: string;
  libraries: ContentLibraries;
  /** Item-level status records distinguish unsaved drafts from committed evidence. */
  status?: Record<string, unknown>;
  /** Raw incomplete drafts stay recoverable without weakening durable validators. */
  drafts?: ContentDraftEvidence[];
}

/** Export needs no database write/read: it works when browser storage is blocked. */
export function createContentBackup(libraries: ContentLibraries, status?: Record<string, unknown>,
  preservedDrafts: ContentDraftEvidence[] = []): ContentBackup {
  const copied = structuredClone(libraries), drafts: ContentDraftEvidence[] = [];
  const partition = <T extends { id: string }>(kind: ContentRow['kind'], entries: T[], decode: (raw: unknown) => T | null): T[] =>
    entries.flatMap(entry => {
      const valid = decode(entry);
      if (valid) return [valid];
      drafts.push({ kind, id: entry.id, raw: JSON.stringify(entry) });
      return [];
    });
  return { version: 1, exportedAt: new Date().toISOString(), status, libraries: {
    validation: partition('validation', copied.validation, validationContent.decode),
    comparison: partition('comparison', copied.comparison, comparisonContent.decode),
    document: partition('document', copied.document, documentContent.decode),
  }, drafts: mergeContentDrafts(parseContentDrafts(preservedDrafts), pendingContentDrafts(), drafts) };
}

export function parseContentBackup(text: string): ContentBackup {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object') throw new Error('Invalid library backup');
  const backup = value as Record<string, unknown>;
  if (backup.version !== 1 || !backup.libraries || typeof backup.libraries !== 'object') throw new Error('Unsupported library backup');
  const libraries = backup.libraries as Record<string, unknown>;
  const parse = <T extends { id: string }>(kind: string, decode: (value: unknown) => T | null): T[] => {
    const values = libraries[kind];
    if (!Array.isArray(values)) throw new Error(`Invalid ${kind} library`);
    const entries: T[] = [];
    const ids = new Set<string>();
    for (const raw of values) {
      const entry = decode(raw);
      if (!entry) throw new Error(`Invalid ${kind} entry`);
      if (ids.has(entry.id)) throw new Error(`Duplicate ${kind} entry ID`);
      ids.add(entry.id);
      entries.push(entry);
    }
    return entries;
  };
  return { version: 1, exportedAt: typeof backup.exportedAt === 'string' ? backup.exportedAt : '', libraries: {
    validation: parse('validation', validationContent.decode),
    comparison: parse('comparison', comparisonContent.decode),
    document: parse('document', documentContent.decode),
  }, drafts: parseContentDrafts(backup.drafts) };
}

/** Preserve originals on ID conflicts by importing a separately identified copy. */
export async function importContentBackup(backup: ContentBackup): Promise<number> {
  // Validate even when a caller constructs the object directly.
  const parsed = parseContentBackup(JSON.stringify(backup)), libraries = parsed.libraries, drafts = parsed.drafts ?? [];
  // Refusal leaves the raw evidence exportable for this session as well.
  stageContentDrafts(drafts);
  const recovery = await draftRecoveryRows(drafts);
  // Hash before opening a transaction: Web Crypto must not let IDB auto-commit.
  const fingerprints = new Map<object, string>();
  await Promise.all((['validation', 'comparison', 'document'] as const).flatMap(kind => libraries[kind].map(async entry => {
    const canonical = JSON.stringify(entry, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
    const hash = await computeFullSourceHash(new TextEncoder().encode(canonical));
    if (!hash) throw new Error('Web Crypto is required to import library backups');
    fingerprints.set(entry, `${kind}:${hash}`);
  })));
  const tx = await contentTransaction(['items', 'recovery'], 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore('items');
  let imported = 0;
  const read = store.getAll();
  read.onsuccess = () => {
    const known = new Map((read.result as ContentRow[]).map(row => [`${row.kind}:${row.id}`, row]));
    const importedSources = new Map((read.result as ContentRow[]).map(row => [row.importedFrom, row]));
    const put = (kind: ContentRow['kind'], original: { id: string }, copy: () => { id: string }, prepared = original): string => {
      const current = known.get(`${kind}:${original.id}`);
      if (current && !current.deleted && sameReportEvidence(current.payload, prepared)) return current.id;
      const importedFrom = fingerprints.get(original);
      const previous = importedSources.get(importedFrom);
      if (previous) return previous.id;
      const payload = current ? copy() : prepared;
      const row: ContentRow = { kind, id: payload.id, version: 1, revision: 1, createdAt: contentCreatedAt(),
        modifiedAt: Date.now(), deleted: false, payload, importedFrom };
      store.add(row); known.set(`${kind}:${row.id}`, row); importedSources.set(importedFrom, row); imported++;
      return row.id;
    };
    const validation = new Map(libraries.validation.map(entry => [entry.id,
      put('validation', entry, () => newSavedReport(entry.snapshot, entry.name, entry.automation))]));
    const comparison = new Map(libraries.comparison.map(entry => [entry.id,
      put('comparison', entry, () => ({ ...entry, id: crypto.randomUUID() }))]));
    for (const entry of libraries.document) {
      const rebound = rebindContentDocument(entry, comparison, validation);
      put('document', entry, () => parseDocumentFile(JSON.stringify(rebound)), rebound);
    }
    for (const original of recovery) tx.objectStore('recovery').put(original);
  };
  await done;
  forgetContentDrafts(drafts);
  for (const kind of ['validation', 'comparison', 'document'] as const) announceContentChange(kind);
  return imported;
}

async function readStoredRecovery(): Promise<RecoveryRow[]> {
  const tx = await contentTransaction('recovery', 'readonly');
  const done = transactionDone(tx);
  const request = requestValue(tx.objectStore('recovery').getAll()) as Promise<RecoveryRow[]>;
  const [rows] = await Promise.all([request, done]);
  return rows;
}

/** Re-export archived and session-only drafts; a refused read never blocks a download. */
export async function readBackupDrafts(): Promise<{ drafts: ContentDraftEvidence[]; complete: boolean }> {
  try {
    const rows = await readStoredRecovery();
    const archived = rows.filter(row => row.key.startsWith(BACKUP_DRAFT_PREFIX))
      .flatMap(row => parseContentDrafts([JSON.parse(row.raw)]));
    return { drafts: mergeContentDrafts(archived, pendingContentDrafts()), complete: true };
  } catch (error) {
    console.warn('[User content] Archived draft evidence could not be read; exporting current session', error);
    return { drafts: pendingContentDrafts(), complete: false };
  }
}

/** Retry raw evidence too; saving valid libraries alone must not claim the whole import saved. */
export async function retryContentDrafts(): Promise<boolean> {
  const drafts = pendingContentDrafts();
  if (!drafts.length) return true;
  try {
    const rows = await draftRecoveryRows(drafts);
    const tx = await contentTransaction('recovery', 'readwrite'), done = transactionDone(tx);
    for (const row of rows) tx.objectStore('recovery').put(row);
    await done; forgetContentDrafts(drafts);
    return true;
  } catch (error) { console.warn('[User content] Draft evidence remains in this session', error); return false; }
}

export async function readContentRecovery(): Promise<RecoveryRow[]> {
  const rows: RecoveryRow[] = [];
  let failure: unknown;
  try {
    rows.push(...await readStoredRecovery());
  } catch (error) { console.warn('[User content] Reading preserved originals failed', error); failure = error; }
  // A failed migration must not prevent exporting its still-intact local original.
  for (const definition of [validationContent, comparisonContent, documentContent]) {
    try {
      for (const original of readLegacyOriginals(definition.legacyKey)) {
        if (!rows.some(row => row.key === original.key && row.raw === original.raw)) {
          rows.push({ key: `${original.key}:local-copy`, raw: original.raw, createdAt: Date.now() });
        }
      }
    } catch (error) { console.warn('[User content] Reading legacy originals failed', error); failure = error; }
  }
  for (const [index, draft] of pendingContentDrafts().entries()) {
    const raw = JSON.stringify(draft);
    if (!rows.some(row => row.raw === raw)) rows.push({ key: `${BACKUP_DRAFT_PREFIX}session:${index}`, raw, createdAt: Date.now() });
  }
  if (!rows.length && failure) throw failure;
  return rows;
}

/** Only explicit user cleanup removes verified legacy values; changed values stay put.
 * Older tabs must be closed: localStorage cannot atomically compare-and-remove. */
export async function cleanupContentLegacy(): Promise<void> {
  const tx = await contentTransaction(['migrations', 'recovery'], 'readonly');
  const done = transactionDone(tx);
  const markers = requestValue(tx.objectStore('migrations').getAll()) as Promise<MigrationRow[]>;
  const originals = requestValue(tx.objectStore('recovery').getAll()) as Promise<RecoveryRow[]>;
  const [migrations, recovery] = await Promise.all([markers, originals, done]);
  for (const marker of migrations) {
    if (marker.originalKey !== null && !recovery.some(entry => entry.key === marker.originalKey)) {
      throw new Error('Original library has not been preserved');
    }
  }
  for (const original of recovery) {
    if (localStorage.getItem(original.key) === original.raw) localStorage.removeItem(original.key);
  }
}

/** TODO(remove-by: next incompatible viewer release, owner: louistrue), #6679.
 * Older tabs can still write legacy keys. Archive changes; never replay their libraries. */
export async function preserveLegacyChange(key: string, raw: string): Promise<void> {
  const keys = [validationContent.legacyKey, comparisonContent.legacyKey, documentContent.legacyKey];
  if (!keys.includes(key)) return;
  const tx = await contentTransaction('recovery', 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore('recovery').add({ key: `${key}:later:${crypto.randomUUID()}`, raw, createdAt: Date.now() } satisfies RecoveryRow);
  await done;
}
