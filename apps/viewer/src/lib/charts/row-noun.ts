/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChartSource } from '@ifc-lite/charts';

/**
 * What one dataset row is, per chart source (#5218). A bucket's `count` and a
 * count chart's `total` are ROWS, and a row is an element only for the
 * `elements` source: a clash row is a pair, a bcf row a topic, a schedule row
 * a task, an ids row a (specification, entity) result, a compare row a diff
 * entry (each dataset's own doc comment under `./datasets/`). Every place
 * that names such a count takes the noun from here, so a clash chart never
 * reads "40 elements" for 40 pairs.
 */
const ROW_NOUN: Record<ChartSource, { one: string; many: string }> = {
  elements: { one: 'element', many: 'elements' },
  clash: { one: 'clash', many: 'clashes' },
  bcf: { one: 'topic', many: 'topics' },
  schedule: { one: 'task', many: 'tasks' },
  ids: { one: 'result', many: 'results' },
  compare: { one: 'entry', many: 'entries' },
};

/** "15 elements", "1 clash", "3 topics". */
export function countRows(n: number, source: ChartSource): string {
  const noun = ROW_NOUN[source];
  return `${n.toLocaleString()} ${n === 1 ? noun.one : noun.many}`;
}

/** A column header for a row count: "Elements", "Clashes", "Topics". */
export function rowCountHeader(source: ChartSource): string {
  const many = ROW_NOUN[source].many;
  return many.charAt(0).toUpperCase() + many.slice(1);
}
