/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { sameReportEvidence } from '../flow/report-provenance.js';

export class LibraryRowsConflict extends Error {}

/** Apply genuine session changes to a freshly read native library (#7300).
 * Unchanged rows follow durable peer edits/deletions; conflicting changes refuse.
 * The caller still owns the final fresh-source check and synchronous write. */
export function reconcileLibraryRows<T extends { id: string }>(
  durable: readonly T[], baseline: readonly T[], proposed: readonly T[], encode: (row: T) => unknown,
): T[] {
  // Native codecs allow repeated IDs. An ID scopes a CRUD operation, not a
  // proof that the saved library contains just one row with that identity.
  const grouped = (input: readonly T[]): Map<string, T[]> => {
    const groups = new Map<string, T[]>();
    for (const row of input) {
      const group = groups.get(row.id);
      if (group) group.push(row);
      else groups.set(row.id, [row]);
    }
    return groups;
  };
  const rows = grouped(durable), previous = grouped(baseline), current = grouped(proposed);
  const equal = (a: T[] | undefined, b: T[] | undefined) => a === undefined || b === undefined
    ? a === b : sameReportEvidence(a.map(encode), b.map(encode));
  for (const id of new Set([...previous.keys(), ...current.keys()])) {
    const before = previous.get(id), next = current.get(id), saved = rows.get(id);
    if (equal(before, next)) continue;
    if (!equal(before, saved) && !equal(next, saved)) {
      throw new LibraryRowsConflict('The saved library changed independently. Reload it before retrying these edits.');
    }
    if (next) rows.set(id, [...next]);
    else rows.delete(id);
  }
  const ordered: T[] = [];
  for (const row of proposed) {
    const saved = rows.get(row.id);
    const next = saved?.shift();
    if (next) ordered.push(next);
    if (saved?.length === 0) rows.delete(row.id);
  }
  return [...ordered, ...[...rows.values()].flat()];
}
