/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ContentStatus } from '@/lib/storage/content-library';
import { boundedPage, type PageRequest } from './result-limit';

/**
 * A paged read of a durable content library (#10794). Each entry pages together with its own save state, beside a
 * fixed-size storage summary (phase, recovered, entry_count, counts by save state), so neither the entries nor the
 * per-entry save states can push one read over the result limit. Save states whose entry is gone (a failed or
 * pending deletion) page as rows after the entries, so a stuck delete stays visible by id. `total` and
 * `next_offset` count those rows too; a page's `storage.items` maps the ids on that page to their save states.
 * A page past offset 0 needs the previous page's `page_revision`; any change to an entry or save state refuses it.
 */
export function libraryPage<T extends { id: string }>(entries: readonly T[], status: ContentStatus, request: PageRequest, rest: Record<string, unknown>) {
  const counts: Record<string, number> = {};
  for (const state of Object.values(status.items)) counts[state] = (counts[state] ?? 0) + 1;
  const summary = { phase: status.phase, recovered: status.recovered, entry_count: entries.length, counts };
  const ids = new Set(entries.map(entry => entry.id)), orphans = Object.keys(status.items).filter(id => !ids.has(id));
  // Rows measured as the page writes them: the entry, and its id again as the key of its save state. The whole list is
  // paged (not a tail from the offset), so every offset boundedPage reports, its refusal included, is absolute.
  const rows = [...entries.map(entry => ({ entry, id: entry.id })), ...orphans.map(id => ({ entry: undefined, id }))]
    .map(row => ({ ...row, items: { [row.id]: status.items[row.id] ?? null } }));
  // page_revision digests every row, ids and save states, so any change between two pages refuses the second.
  const { items, ...page } = boundedPage(rows, request, { ...rest, storage: summary });
  const saved = items.flatMap(({ id }) => (status.items[id] === undefined ? [] : [[id, status.items[id]] as const]));
  return { entries: items.flatMap(({ entry }) => (entry ? [entry] : [])), page, storage: { ...summary, items: Object.fromEntries(saved) } };
}
