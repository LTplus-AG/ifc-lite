/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SavedConversation } from '../assistant/persistence.js';
import type { ClashGroupWorkspace } from '../clash/group-workspace.js';
import type { DraftBatch } from '../bcf-drafts/draft-types.js';
import type { BcfPublication } from '../bcf-publication/outbox-types.js';
import type { ModelChangeReceipt } from '../actions/model-change-commit.js';
import type { ClashGroupApplication } from '../clash/group-applications.js';
import type { ReviewWorkspace } from '../review/workspace.js';
import type { SavedClashReport } from '../clash/saved-report-schema.js';
import type { SavedValidationReport } from '../validation/reports/history.js';
import type { SavedComparison } from '../compare/savedComparisonSchema.js';
import type { DocumentSpec } from '../document/types.js';
import { contentTransaction, transactionDone, requestValue, type ContentRow, type MigrationRow, type RecoveryRow } from './content-database.js';
import type { ContentCommitReceipt } from './content-library.js';
import { announceContentChange } from './content-events.js';
import { sameReportEvidence } from '../flow/report-provenance.js';
import { readLegacyOriginals } from './content-migration.js';
import { forgetContentImports, pendingContentImports, planContentImport, prepareContentImport, rememberContentImports } from './content-import-plan.js';
import { BACKUP_DRAFT_PREFIX, draftRecoveryRows, forgetContentDrafts, mergeContentDrafts, parseContentDrafts,
  pendingContentDrafts, stageContentDrafts, type ContentDraftEvidence } from './content-backup-drafts.js';
import { CONTENT_KINDS, CONTENT_POLICIES } from './content-kinds.js';
import { CONTENT_DEFINITIONS, contentKindForLegacyKey } from './content-registry.js';

export interface ContentLibraries {
  validation: SavedValidationReport[];
  comparison: SavedComparison[];
  document: DocumentSpec[];
  /** Optional for backups written before assistant conversations existed. */
  assistant?: SavedConversation[];
  clashGroups?: ClashGroupWorkspace[];
  bcfDrafts?: DraftBatch[];
  /** Imported outbox records always arrive blocked; see `quarantineImported`. */
  bcfOutbox?: BcfPublication[];
  /** Optional for backups written before reviewed model change receipts existed. */
  modelChanges?: ModelChangeReceipt[];
  /** Optional for backups written before AI clash group apply receipts existed. */
  clashGroupApplications?: ClashGroupApplication[];
  /** Optional for backups written before coordination review decisions existed. */
  reviewWorkspaces?: ReviewWorkspace[];
  /** Optional for backups written before saved clash reports existed. */
  clashReports?: SavedClashReport[];
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
      const raw = JSON.stringify(entry), valid = decode(JSON.parse(raw));
      if (valid) return [valid];
      drafts.push({ kind, id: entry.id, raw });
      return [];
    });
  return { version: 1, exportedAt: new Date().toISOString(), status, libraries: {
    validation: partition('validation', copied.validation, CONTENT_DEFINITIONS.validation.decode),
    comparison: partition('comparison', copied.comparison, CONTENT_DEFINITIONS.comparison.decode),
    document: partition('document', copied.document, CONTENT_DEFINITIONS.document.decode),
    ...(copied.assistant ? { assistant: partition('assistant', copied.assistant, CONTENT_DEFINITIONS.assistant.decode) } : {}),
    ...(copied.clashGroups ? { clashGroups: partition('clashGroups', copied.clashGroups, CONTENT_DEFINITIONS.clashGroups.decode) } : {}),
    ...(copied.bcfDrafts ? { bcfDrafts: partition('bcfDrafts', copied.bcfDrafts, CONTENT_DEFINITIONS.bcfDrafts.decode) } : {}),
    ...(copied.bcfOutbox ? { bcfOutbox: partition('bcfOutbox', copied.bcfOutbox, CONTENT_DEFINITIONS.bcfOutbox.decode) } : {}),
    ...(copied.modelChanges ? { modelChanges: partition('modelChanges', copied.modelChanges, CONTENT_DEFINITIONS.modelChanges.decode) } : {}),
    ...(copied.clashGroupApplications ? { clashGroupApplications: partition('clashGroupApplications', copied.clashGroupApplications, CONTENT_DEFINITIONS.clashGroupApplications.decode) } : {}),
    ...(copied.reviewWorkspaces ? { reviewWorkspaces: partition('reviewWorkspaces', copied.reviewWorkspaces, CONTENT_DEFINITIONS.reviewWorkspaces.decode) } : {}),
    ...(copied.clashReports ? { clashReports: partition('clashReports', copied.clashReports, CONTENT_DEFINITIONS.clashReports.decode) } : {}),
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
    validation: parse('validation', CONTENT_DEFINITIONS.validation.decode),
    comparison: parse('comparison', CONTENT_DEFINITIONS.comparison.decode),
    document: parse('document', CONTENT_DEFINITIONS.document.decode),
    ...(libraries.assistant !== undefined ? { assistant: parse('assistant', CONTENT_DEFINITIONS.assistant.decode) } : {}),
    ...(libraries.clashGroups !== undefined ? { clashGroups: parse('clashGroups', CONTENT_DEFINITIONS.clashGroups.decode) } : {}),
    ...(libraries.bcfDrafts !== undefined ? { bcfDrafts: parse('bcfDrafts', CONTENT_DEFINITIONS.bcfDrafts.decode) } : {}),
    ...(libraries.bcfOutbox !== undefined ? { bcfOutbox: parse('bcfOutbox', CONTENT_DEFINITIONS.bcfOutbox.decode) } : {}),
    ...(libraries.modelChanges !== undefined ? { modelChanges: parse('modelChanges', CONTENT_DEFINITIONS.modelChanges.decode) } : {}),
    ...(libraries.clashGroupApplications !== undefined ? { clashGroupApplications: parse('clashGroupApplications', CONTENT_DEFINITIONS.clashGroupApplications.decode) } : {}),
    ...(libraries.reviewWorkspaces !== undefined ? { reviewWorkspaces: parse('reviewWorkspaces', CONTENT_DEFINITIONS.reviewWorkspaces.decode) } : {}),
    ...(libraries.clashReports !== undefined ? { clashReports: parse('clashReports', CONTENT_DEFINITIONS.clashReports.decode) } : {}),
  }, drafts: parseContentDrafts(backup.drafts) };
}

/** A refused commit carries the canonical independent drafts; UI does not re-plan it. */
export class ContentImportFailure extends Error {
  constructor(cause: unknown, readonly entries: ContentLibraries) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

async function readImportRows(): Promise<ContentRow[]> {
  const tx = await contentTransaction('items', 'readonly'), done = transactionDone(tx);
  const [rows] = await Promise.all([requestValue(tx.objectStore('items').getAll()) as Promise<ContentRow[]>, done]);
  return rows;
}

/** Preserve originals on conflicts; atomic commit and refusal use one canonical plan. */
export async function importContentBackup(backup: ContentBackup, readVisible?: () => ContentLibraries, allowCommit = true,
  committed?: (rows: readonly ContentCommitReceipt[]) => void): Promise<number> {
  const parsed = parseContentBackup(JSON.stringify(backup)), drafts = parsed.drafts ?? [];
  stageContentDrafts(drafts);
  const prepared = await prepareContentImport(parsed.libraries), recovery = await draftRecoveryRows(drafts);
  let planned: ContentRow[] = [];
  let receipts: ContentCommitReceipt[] = [];
  try {
    if (!allowCommit) throw new Error('Existing libraries could not be safely initialized');
    const tx = await contentTransaction(['items', 'recovery'], 'readwrite'), done = transactionDone(tx);
    const read = tx.objectStore('items').getAll();
    read.onsuccess = () => {
      const visible = readVisible?.();
      planned = planContentImport(prepared, read.result as ContentRow[], visible);
      receipts = planned.map(row => {
        const staged = visible?.[row.kind]?.find(entry => entry.id === row.id);
        return { ...row, ...(staged ? { stagedPayload: structuredClone(staged) } : {}) };
      });
      rememberContentImports(planned);
      for (const row of planned) tx.objectStore('items').add(row);
      for (const original of recovery) tx.objectStore('recovery').put(original);
    };
    await done;
  } catch (error) {
    let existing: ContentRow[] = [], trusted = false;
    try { existing = await readImportRows(); trusted = allowCommit; }
    catch (readError) { console.warn('[User content] Existing import identities could not be read; preserving independent local copies', readError); }
    const visible = readVisible?.();
    planned = planContentImport(prepared, existing, visible, trusted);
    rememberContentImports(planned);
    const entries: ContentLibraries = { validation: [], comparison: [], document: [],
      ...(parsed.libraries.assistant ? { assistant: [] } : {}), ...(parsed.libraries.clashGroups ? { clashGroups: [] } : {}),
      ...(parsed.libraries.bcfDrafts ? { bcfDrafts: [] } : {}), ...(parsed.libraries.bcfOutbox ? { bcfOutbox: [] } : {}),
      ...(parsed.libraries.modelChanges ? { modelChanges: [] } : {}),
      ...(parsed.libraries.clashGroupApplications ? { clashGroupApplications: [] } : {}),
      ...(parsed.libraries.reviewWorkspaces ? { reviewWorkspaces: [] } : {}),
      ...(parsed.libraries.clashReports ? { clashReports: [] } : {}) };
    for (const row of planned) {
      // Keep newer edits to an already-staged identity. Reimport is not an undo.
      const current = visible?.[row.kind]?.find(entry => entry.id === row.id);
      if (current && (CONTENT_POLICIES[row.kind].immutableEvidence || sameReportEvidence(current, row.payload))) continue;
      if (row.kind === 'assistant') { const entry = CONTENT_DEFINITIONS.assistant.decode(row.payload); if (entry) (entries.assistant ??= []).push(entry); }
      if (row.kind === 'clashGroups') { const entry = CONTENT_DEFINITIONS.clashGroups.decode(row.payload); if (entry) (entries.clashGroups ??= []).push(entry); }
      if (row.kind === 'bcfDrafts') { const entry = CONTENT_DEFINITIONS.bcfDrafts.decode(row.payload); if (entry) (entries.bcfDrafts ??= []).push(entry); }
      if (row.kind === 'bcfOutbox') { const entry = CONTENT_DEFINITIONS.bcfOutbox.decode(row.payload); if (entry) (entries.bcfOutbox ??= []).push(entry); }
      if (row.kind === 'modelChanges') { const entry = CONTENT_DEFINITIONS.modelChanges.decode(row.payload); if (entry) (entries.modelChanges ??= []).push(entry); }
      if (row.kind === 'clashGroupApplications') { const entry = CONTENT_DEFINITIONS.clashGroupApplications.decode(row.payload); if (entry) (entries.clashGroupApplications ??= []).push(entry); }
      if (row.kind === 'reviewWorkspaces') { const entry = CONTENT_DEFINITIONS.reviewWorkspaces.decode(row.payload); if (entry) (entries.reviewWorkspaces ??= []).push(entry); }
      if (row.kind === 'clashReports') { const entry = CONTENT_DEFINITIONS.clashReports.decode(row.payload); if (entry) (entries.clashReports ??= []).push(entry); }
      if (row.kind === 'document') { const entry = CONTENT_DEFINITIONS.document.decode(row.payload); if (entry) entries.document.push(entry); }
      if (row.kind === 'comparison') { const entry = CONTENT_DEFINITIONS.comparison.decode(row.payload); if (entry) entries.comparison.push(entry); }
      if (row.kind === 'validation') { const entry = CONTENT_DEFINITIONS.validation.decode(row.payload); if (entry) entries.validation.push(entry); }
    }
    throw new ContentImportFailure(error, entries);
  }
  forgetContentDrafts(drafts); forgetContentImports(planned);
  committed?.(receipts);
  for (const kind of CONTENT_KINDS) announceContentChange(kind);
  return planned.length;
}

/** Verify first-write provenance before claiming a whole refused import was saved. */
export async function retryContentImports(): Promise<boolean> {
  const pending = pendingContentImports();
  if (!pending.length) return true;
  try {
    const rows = new Map((await readImportRows()).map(row => [`${row.kind}:${row.id}`, row]));
    const completed = pending.filter(source => rows.get(`${source.kind}:${source.id}`)?.importedFrom === source.importedFrom);
    forgetContentImports(completed);
    return completed.length === pending.length;
  } catch (error) { console.warn('[User content] Imported source identities could not be verified', error); return false; }
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
  for (const definition of Object.values(CONTENT_DEFINITIONS)) {
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
  if (!contentKindForLegacyKey(key)) return;
  const tx = await contentTransaction('recovery', 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore('recovery').add({ key: `${key}:later:${crypto.randomUUID()}`, raw, createdAt: Date.now() } satisfies RecoveryRow);
  await done;
}
