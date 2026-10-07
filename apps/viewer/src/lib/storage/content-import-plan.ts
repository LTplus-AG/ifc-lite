/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ContentLibraries } from './content-backup.js';
import { contentCreatedAt, type ContentRow } from './content-database.js';
import { sameReportEvidence } from '../flow/report-provenance.js';
import { newSavedReport } from '../validation/reports/history.js';
import { parseDocumentFile } from '../document/persistence.js';
import { CONTENT_KINDS } from './content-kinds.js';
import { CONTENT_DEFINITIONS } from './content-registry.js';
import { rebindContentDocument } from './content-backup-references.js';
import { computeFullSourceHash } from '../../utils/sourceContentHash.js';
import type { DocumentSpec } from '../document/types.js';
import type { ClashGroupApplication } from '../clash/group-applications.js';
import { forgetImportIdentity, rememberImportIdentity } from './content-import-identity.js';
import { quarantineImported } from '../bcf-publication/outbox-state.js';

export interface PreparedContentImport { libraries: ContentLibraries; fingerprints: Map<object, string> }
const pending = new Map<string, ContentRow>();
const key = (kind: ContentRow['kind'], id: string) => `${kind}:${id}`;
export function sameImportEvidence(left: unknown, right: unknown): boolean {
  const withoutName = (value: unknown) => {
    if (!value || typeof value !== 'object') return value;
    const { name: _name, ...evidence } = value as Record<string, unknown>;
    return evidence;
  };
  return sameReportEvidence(withoutName(left), withoutName(right));
}

/** Prepare identities before IDB; asynchronous hashing must never auto-commit a transaction. */
export async function prepareContentImport(libraries: ContentLibraries): Promise<PreparedContentImport> {
  const fingerprints = new Map<object, string>();
  await Promise.all(CONTENT_KINDS.flatMap(kind => (libraries[kind] ?? []).map(async entry => {
    const canonical = JSON.stringify(entry, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
    const hash = await computeFullSourceHash(new TextEncoder().encode(canonical));
    if (!hash) throw new Error('Web Crypto is required to import library backups');
    fingerprints.set(entry, `${kind}:${hash}`);
  })));
  return { libraries, fingerprints };
}

/** Both atomic writes and refused-import staging use these exact conflict/dedup rules. */
function rebindApplication(entry: ClashGroupApplication, workspaceId: string): ClashGroupApplication {
  if (workspaceId === entry.workspaceId) return entry;
  return { ...entry, workspaceId, after: { ...entry.after, id: workspaceId }, before: entry.before && { ...entry.before, id: workspaceId } };
}

export function planContentImport(prepared: PreparedContentImport, existing: ContentRow[], visible?: ContentLibraries,
  trustedExisting = true): ContentRow[] {
  const known = new Map(existing.map(row => [key(row.kind, row.id), row]));
  if (visible) for (const kind of CONTENT_KINDS) for (const entry of visible[kind] ?? []) {
    if (!known.has(key(kind, entry.id))) known.set(key(kind, entry.id), { kind, id: entry.id, version: 1, revision: 0,
      createdAt: 0, modifiedAt: 0, deleted: false, payload: entry });
  }
  const sources = new Map([...pending, ...existing.filter(row => row.importedFrom).map(row => [row.importedFrom!, row] as const)]);
  const rows: ContentRow[] = [];
  const add = (kind: ContentRow['kind'], original: { id: string }, copy: () => { id: string }, payload = original,
    rebindPending?: (value: { id: string }) => { id: string }): string => {
    const current = known.get(key(kind, original.id)), importedFrom = prepared.fingerprints.get(original);
    if (current && !current.deleted && sameReportEvidence(current.payload, payload) && current.revision > 0) return current.id;
    const previous = importedFrom ? sources.get(importedFrom) : undefined;
    if (previous) {
      const saved = known.get(key(kind, previous.id));
      if (saved && (saved.importedFrom === importedFrom || !saved.deleted && saved.revision > 0
        && sameImportEvidence(saved.payload, previous.payload))) return saved.id;
      if (saved && (saved.deleted || saved.revision > 0)) payload = copy();
      else {
        const decode = CONTENT_DEFINITIONS[kind].decode;
        const currentDraft = saved && decode(JSON.parse(JSON.stringify(saved.payload)));
        payload = currentDraft ?? previous.payload as { id: string };
        if (rebindPending) payload = rebindPending(payload);
      }
    } else if ((current && !sameReportEvidence(current.payload, payload)) || current?.deleted || !current && !trustedExisting) payload = copy();
    const row: ContentRow = { kind, id: payload.id, version: 1, revision: 1, createdAt: contentCreatedAt(),
      modifiedAt: Date.now(), deleted: false, payload, importedFrom };
    rows.push(row); known.set(key(kind, row.id), row);
    if (importedFrom) sources.set(importedFrom, row);
    return row.id;
  };
  const { libraries } = prepared;
  const validation = new Map(libraries.validation.map(entry => [entry.id,
    add('validation', entry, () => newSavedReport(entry.snapshot, entry.name, entry.automation))]));
  const comparison = new Map(libraries.comparison.map(entry => [entry.id,
    add('comparison', entry, () => ({ ...entry, id: crypto.randomUUID() }))]));
  const oldReferences = (kind: 'comparison' | 'validation', selected: Map<string, string>): Map<string, string> => {
    const references = new Map(selected);
    for (const entry of libraries[kind]) {
      const fingerprint = prepared.fingerprints.get(entry), old = fingerprint ? pending.get(fingerprint) : undefined;
      const current = selected.get(entry.id);
      if (old && current) references.set(old.id, current);
    }
    return references;
  };
  const comparisonReferences = oldReferences('comparison', comparison), validationReferences = oldReferences('validation', validation);
  for (const entry of libraries.document) {
    const rebound = rebindContentDocument(entry, comparison, validation);
    add('document', entry, () => parseDocumentFile(JSON.stringify(rebound)), rebound,
      previous => rebindContentDocument(previous as DocumentSpec, comparisonReferences, validationReferences));
  }
  for (const entry of libraries.assistant ?? []) add('assistant', entry, () => ({ ...entry, id: crypto.randomUUID() }));
  const workspaceIds = new Map((libraries.clashGroups ?? []).map(entry =>
    [entry.id, add('clashGroups', entry, () => ({ ...entry, id: crypto.randomUUID() }))] as const));
  for (const entry of libraries.bcfDrafts ?? []) add('bcfDrafts', entry, () => ({ ...entry, id: crypto.randomUUID() }));
  for (const entry of libraries.modelChanges ?? []) add('modelChanges', entry, () => ({ ...entry, id: crypto.randomUUID() }));
  // A receipt follows its workspace: when the import gives the workspace a new id, the receipt (and its undo) names the copy.
  for (const entry of libraries.clashGroupApplications ?? []) {
    const rebound = rebindApplication(entry, workspaceIds.get(entry.workspaceId) ?? entry.workspaceId);
    add('clashGroupApplications', entry, () => ({ ...rebound, id: crypto.randomUUID() }), rebound);
  }
  for (const entry of libraries.reviewWorkspaces ?? []) add('reviewWorkspaces', entry, () => ({ ...entry, id: crypto.randomUUID() }));
  for (const entry of libraries.semanticReviews ?? []) add('semanticReviews', entry, () => ({ ...entry, id: crypto.randomUUID() }));
  // An imported outbox never dispatches by itself: every unfinished effect is blocked until checked against the server.
  for (const entry of libraries.bcfOutbox ?? []) {
    const quarantined = quarantineImported(entry);
    add('bcfOutbox', entry, () => ({ ...quarantined, id: crypto.randomUUID() }), quarantined);
  }
  return rows;
}

export function rememberContentImports(rows: ContentRow[]): void {
  for (const row of rows) if (row.importedFrom) {
    pending.set(row.importedFrom, row);
    rememberImportIdentity(row.kind, row.id, row.importedFrom);
  }
}
export function pendingContentImports(): ContentRow[] { return [...pending.values()]; }
export function forgetContentImports(rows: ContentRow[]): void {
  for (const row of rows) if (row.importedFrom) {
    pending.delete(row.importedFrom);
    forgetImportIdentity(row.kind, row.id, row.importedFrom);
  }
}
