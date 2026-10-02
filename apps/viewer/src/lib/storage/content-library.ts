/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { contentFailure, readContentRows, writeContent, type ContentFailure } from './content-database.js';
import { migrateContent, LegacyMigrationFailure, type ContentDefinition } from './content-migration.js';

type ContentSaveState = 'saving' | 'saved' | ContentFailure;
export interface ContentStatus {
  phase: 'loading' | 'ready' | 'unavailable';
  recovered: boolean;
  items: Record<string, ContentSaveState>;
}
export const initialContentStatus = (): ContentStatus => ({ phase: 'loading', recovered: false, items: {} });

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
  let editGeneration = 0;
  const emit = () => publish(read(), { ...status, items: { ...status.items } });
  const change = (id: string, entry: T | null) => {
    const current = read();
    const entries = entry ? current.map(value => value.id === id ? entry : value) : current.filter(value => value.id !== id);
    if (entry && !current.some(value => value.id === id)) entries.push(entry);
    publish(entries, { ...status, items: { ...status.items } });
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
      publish([...entries.values()], { ...status, items: { ...status.items } });
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
        publish([...entries.values()], { ...status, items: { ...status.items } });
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
    if (!revisions.has(id)) revisions.set(id, 0);
    generations.set(id, (generations.get(id) ?? 0) + 1);
    dirty.set(id, entry === null ? null : structuredClone(entry));
    status.items[id] = reason; change(id, entry);
  };
  const put = (id: string, value: T | null): Promise<boolean> => {
    let entry: T | null;
    try {
      // Capture the portable JSON contract once per item, not the entire library.
      // Undefined optional fields remain omitted exactly as in existing exports.
      entry = value === null ? null : definition.decode(JSON.parse(JSON.stringify(value)));
    } catch (error) {
      console.warn('[User content] Invalid draft remains in memory', error);
      entry = null;
    }
    if (value !== null && !entry) { stage(id, value, 'invalid'); return Promise.resolve(false); }
    editGeneration++;
    if (!revisions.has(id)) revisions.set(id, 0);
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    dirty.set(id, value); status.items[id] = 'saving'; change(id, value);
    const previous = queues.get(id) ?? Promise.resolve(true);
    const pending = previous.then(async (succeeded) => {
      if (!(await initialize()) || (!succeeded && queues.has(id))) {
        if (generations.get(id) === generation) {
          status.items[id] = status.items[id] === 'saving' ? 'unavailable' : status.items[id]; emit();
        }
        return false;
      }
      const result = await writeContent(definition.kind, id, entry, revisions.get(id) ?? 0);
      if (result.ok) revisions.set(id, result.revision);
      if (generations.get(id) === generation) {
        status.items[id] = result.ok ? 'saved' : result.reason;
        if (result.ok) dirty.delete(id);
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
    const results = await Promise.all([...dirty].map(([id, entry]) => put(id, entry)));
    return results.every(Boolean);
  };
  const refresh = async () => {
    // Never let another tab replace dirty drafts or their expected revisions.
    if (status.phase === 'ready') await load();
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
      dirty.clear(); revisions.clear();
      for (const row of rows) revisions.set(row.id, row.revision);
      status = { ...status, phase: 'ready', items: {} }; publish(entries, status);
      return true;
    } catch (error) { contentFailure(error); return false; }
  };
  return { initialize, put, retry, refresh, stage, restore };
}
