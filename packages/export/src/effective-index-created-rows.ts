/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView, NewEntity } from '@ifc-lite/mutations';

/** The created-row questions the overlay index asks. */
export interface CreatedRows {
  get(id: number): NewEntity | undefined;
  has(id: number): boolean;
  readonly size: number;
  keys(): Iterable<number>;
  [Symbol.iterator](): Iterator<[number, NewEntity]>;
}
export const EMPTY_CREATED: CreatedRows = new Map<number, NewEntity>();

/**
 * Created rows read through the view on demand (#8452). Building an index no
 * longer copies every created row: a point lookup borrows one row, keeps it
 * for the index's lifetime, and only iteration visits the whole overlay. The
 * index answers from the overlay as it stands when asked; like every caller
 * today, build it after the writes it should describe.
 */
export function borrowedCreatedRows(view: MutablePropertyView): CreatedRows | null {
  if (typeof view.readNewEntity !== 'function' || typeof view.readNewEntities !== 'function'
    || typeof view.hasNewEntity !== 'function' || typeof view.getNewEntityCount !== 'function') return null;
  const rows = new Map<number, NewEntity | null>();
  const get = (id: number): NewEntity | undefined => {
    let row = rows.get(id);
    if (row === undefined) rows.set(id, row = view.readNewEntity(id));
    return row ?? undefined;
  };
  return {
    get,
    has: id => rows.has(id) ? rows.get(id) !== null : view.hasNewEntity(id),
    get size() { return view.getNewEntityCount(); },
    *keys() { for (const row of view.readNewEntities()) yield row.expressId; },
    *[Symbol.iterator]() {
      for (const row of view.readNewEntities()) { rows.set(row.expressId, row); yield [row.expressId, row] as [number, NewEntity]; }
    },
  };
}
