/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { contentFailure, readContentRows, writeContent, type ContentFailure, type ContentRow } from './content-database.js';
import { sameReportEvidence } from '../flow/report-provenance.js';
import { migrateContent, LegacyMigrationFailure, type ContentDefinition } from './content-migration.js';

type ContentSaveState = 'saving' | 'saved' | ContentFailure;
export interface ContentStatus {
  phase: 'loading' | 'ready' | 'unavailable';
  recovered: boolean;
  items: Record<string, ContentSaveState>;
}
/** A transient own-import receipt; stagedPayload is never written to IndexedDB. */
export interface ContentCommitReceipt extends ContentRow { stagedPayload?: unknown }
// IDs come from imported files; own properties must also handle __proto__ safely.
const copyItemStatus = (items?: ContentStatus['items']): ContentStatus['items'] => Object.assign(Object.create(null), items);
export const initialContentStatus = (): ContentStatus => ({ phase: 'loading', recovered: false, items: copyItemStatus() });

/** One controller per store slice: edits stay visible before hydration and on refusal.
 * Per-item queues prevent old commits clearing newer drafts; transactions check other tabs. */
export function createContentLibrary<T extends { id: string }>(definition: ContentDefinition<T>,
  read: () => T[], publish: (entries: T[], status: ContentStatus) => void) {
  let status = initialContentStatus();
  let opening: Promise<boolean> | null = null;
  const revisions = new Map<string, number>();
  const dirty = new Map<string, T | null>();
  const queues = new Map<string, Promise<boolean>>();
  const generations = new Map<string, number>();
  // Optional native deletion authority stays with refused tombstones for explicit Retry.
  const deletionGuards = new Map<string, { check: () => boolean; original: T | undefined }>();
  let editGeneration = 0;
  const emit = () => publish(read(), { ...status, items: copyItemStatus(status.items) });
  const change = (id: string, entry: T | null) => {
    const current = read();
    const entries = entry ? current.map(value => value.id === id ? entry : value) : current.filter(value => value.id !== id);
    if (entry && !current.some(value => value.id === id)) entries.push(entry);
    publish(entries, { ...status, items: copyItemStatus(status.items) });
  };
  const load = async (): Promise<boolean> => {
    try {
      const recovered = await migrateContent(definition);
      const rows = await readContentRows(definition.kind);
      const entries = new Map<string, T>();
      for (const row of rows) {
        if (row.revision < (revisions.get(row.id) ?? 0)) {
          const current = read().find(entry => entry.id === row.id);
          if (current) entries.set(current.id, current);
          continue;
        }
        if (dirty.has(row.id) && revisions.has(row.id)) {
          if (row.revision !== revisions.get(row.id)) status.items[row.id] = 'conflict';
          continue;
        }
        revisions.set(row.id, row.revision);
        if (status.items[row.id] && !dirty.has(row.id)) status.items[row.id] = 'saved';
        if (row.deleted) continue;
        const entry = definition.decode(row.payload);
        if (!entry) throw new Error('Stored user content failed validation; original preserved');
        entries.set(entry.id, entry);
      }
      for (const entry of read()) if (dirty.has(entry.id)) entries.set(entry.id, entry);
      for (const [id, entry] of dirty) { if (entry) entries.set(id, entry); else entries.delete(id); }
      status = { ...status, phase: 'ready', recovered };
      publish([...entries.values()], { ...status, items: copyItemStatus(status.items) });
      return true;
    } catch (error) {
      const reason = contentFailure(error);
      status = { ...status, phase: 'unavailable' };
      if (error instanceof LegacyMigrationFailure) {
        const entries = new Map(read().map(entry => [entry.id, entry]));
        for (const raw of error.entries) {
          const entry = definition.decode(raw);
          if (entry && !dirty.has(entry.id)) { entries.set(entry.id, entry); status.items[entry.id] = reason; }
        }
        publish([...entries.values()], { ...status, items: copyItemStatus(status.items) });
      } else emit();
      return false;
    }
  };
  const initialize = (): Promise<boolean> => {
    if (status.phase === 'ready') return Promise.resolve(true);
    if (opening) return opening;
    status = { ...status, phase: 'loading' }; emit();
    opening = load().finally(() => { opening = null; });
    return opening;
  };
  const stage = (id: string, entry: T | null, reason: ContentFailure = 'unavailable'): void => {
    editGeneration++;
    deletionGuards.delete(id);
    if (!revisions.has(id)) revisions.set(id, 0);
    generations.set(id, (generations.get(id) ?? 0) + 1);
    dirty.set(id, entry === null ? null : structuredClone(entry));
    status.items[id] = reason; change(id, entry);
  };
  const portableEntry = (value: T | null): T | null => {
    try {
      // Capture the portable JSON contract once per item, not the entire library.
      // Undefined optional fields remain omitted exactly as in existing exports.
      return value === null ? null : definition.decode(JSON.parse(JSON.stringify(value)));
    } catch (error) {
      console.warn('[User content] Invalid draft remains in memory', error);
      return null;
    }
  };
  const put = (id: string, value: T | null, beforeWrite?: () => boolean): Promise<boolean> => {
    const entry = portableEntry(value);
    if (value !== null && !entry) { stage(id, value, 'invalid'); return Promise.resolve(false); }
    editGeneration++;
    if (!revisions.has(id)) revisions.set(id, 0);
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    if (beforeWrite && value === null) {
      const original = deletionGuards.get(id)?.original ?? read().find(entry => entry.id === id);
      deletionGuards.set(id, { check: beforeWrite, original });
      status.items[id] = 'saving'; emit();
    } else {
      deletionGuards.delete(id);
      dirty.set(id, value); status.items[id] = 'saving'; change(id, value);
    }
    const previous = queues.get(id) ?? Promise.resolve(true);
    const deletionAllowed = (): boolean => {
      if (!beforeWrite || beforeWrite()) return true;
      // A newer native draft owns its own generation; never restore over it.
      if (generations.get(id) === generation) {
        const original = deletionGuards.get(id)?.original;
        deletionGuards.delete(id);
        if (dirty.get(id) === null) dirty.delete(id);
        status.items[id] = 'conflict';
        if (original && !read().some(entry => entry.id === id)) change(id, original);
        else emit();
      }
      return false;
    };
    const pending = previous.then(async (succeeded) => {
      if (!(await initialize()) || (!succeeded && queues.has(id))) {
        if (generations.get(id) === generation) {
          if (beforeWrite && dirty.get(id) !== null) deletionGuards.delete(id);
          status.items[id] = status.items[id] === 'saving' ? 'unavailable' : status.items[id]; emit();
        }
        return false;
      }
      if (beforeWrite && value === null) {
        if (!deletionAllowed()) return false;
        dirty.set(id, value); change(id, value);
      }
      const expected = revisions.get(id) ?? 0;
      let result = await writeContent(definition.kind, id, entry, expected);
      // Only an own commit receipt can advance a dirty row's expected revision.
      // Retry once with its latest reference-merged draft, never the stale snapshot.
      const acknowledged = revisions.get(id) ?? 0;
      if (!result.ok && result.reason === 'conflict' && acknowledged > expected && generations.get(id) === generation) {
        if (!dirty.has(id)) result = { ok: true, revision: acknowledged };
        else {
          const draft = dirty.get(id);
          if (draft === undefined) return false;
          // #7245: an own receipt advances CAS, never deletion approval.
          if (draft === null && !deletionAllowed()) return false;
          const latest = portableEntry(draft);
          if (draft !== null && !latest) { stage(id, draft, 'invalid'); return false; }
          result = await writeContent(definition.kind, id, latest, acknowledged);
        }
      }
      if (result.ok) revisions.set(id, result.revision);
      if (generations.get(id) === generation) {
        status.items[id] = result.ok ? 'saved' : result.reason;
        if (result.ok) { dirty.delete(id); deletionGuards.delete(id); }
        emit();
      }
      return result.ok;
    });
    queues.set(id, pending);
    void pending.finally(() => { if (queues.get(id) === pending) queues.delete(id); });
    return pending;
  };
  const retry = async (): Promise<boolean> => {
    await Promise.all(queues.values());
    if (!(await initialize())) return false;
    const results = await Promise.all([...dirty].map(([id, entry]) => put(id, entry, deletionGuards.get(id)?.check)));
    return results.every(Boolean);
  };
  const refresh = async (committed: readonly ContentCommitReceipt[] = []): Promise<boolean> => {
    // Only receipts from this tab's completed import may acknowledge its drafts.
    // Newer edits stay dirty, but can save against this tab's acknowledged commit.
    for (const row of committed) {
      if (row.kind !== definition.kind || !dirty.has(row.id) || row.revision < (revisions.get(row.id) ?? 0)) continue;
      revisions.set(row.id, row.revision);
      const current = dirty.get(row.id), committedEntry = definition.decode(row.payload);
      if (current && row.stagedPayload !== undefined && committedEntry && definition.mergeCommitted) {
        const merged = definition.mergeCommitted(current, row.stagedPayload, committedEntry);
        dirty.set(row.id, merged); change(row.id, merged);
      }
      if (!sameReportEvidence(dirty.get(row.id), row.deleted ? null : row.payload)) continue;
      dirty.delete(row.id); deletionGuards.delete(row.id); status.items[row.id] = 'saved';
    }
    if (committed.length) emit();
    // Never let another tab replace dirty drafts or their expected revisions.
    return status.phase === 'ready' ? load() : false;
  };
  const restore = async (): Promise<boolean> => {
    const requestedAt = editGeneration;
    await Promise.all(queues.values());
    // Keep drafts until a complete read succeeds; a failed recovery is not a wipe.
    try {
      await migrateContent(definition);
      const rows = await readContentRows(definition.kind);
      const entries: T[] = [];
      for (const row of rows) {
        if (row.deleted) continue;
        const entry = definition.decode(row.payload);
        if (!entry) throw new Error('Saved content cannot be restored');
        entries.push(entry);
      }
      // The confirmation covers existing drafts, never edits made while reading.
      if (editGeneration !== requestedAt) return false;
      dirty.clear(); revisions.clear(); deletionGuards.clear();
      for (const row of rows) revisions.set(row.id, row.revision);
      status = { ...status, phase: 'ready', items: copyItemStatus() }; publish(entries, status);
      return true;
    } catch (error) { contentFailure(error); return false; }
  };
  return { initialize, put, retry, refresh, stage, restore };
}
