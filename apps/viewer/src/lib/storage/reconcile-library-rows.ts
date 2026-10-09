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
  const rows = new Map(durable.map(row => [row.id, row]));
  const previous = new Map(baseline.map(row => [row.id, row]));
  const current = new Map(proposed.map(row => [row.id, row]));
  const equal = (a: T | undefined, b: T | undefined) => a === undefined || b === undefined
    ? a === b : sameReportEvidence(encode(a), encode(b));
  for (const id of new Set([...previous.keys(), ...current.keys()])) {
    const before = previous.get(id), next = current.get(id), saved = rows.get(id);
    if (equal(before, next)) continue;
    if (!equal(before, saved) && !equal(next, saved)) {
      throw new LibraryRowsConflict('The saved library changed independently. Reload it before retrying these edits.');
    }
    if (next) rows.set(id, next);
    else rows.delete(id);
  }
  const ordered: T[] = [];
  for (const row of proposed) {
    const saved = rows.get(row.id);
    if (saved) { ordered.push(saved); rows.delete(row.id); }
  }
  return [...ordered, ...rows.values()];
}
