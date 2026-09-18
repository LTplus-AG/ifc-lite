/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `getTypeName` answers the literal string `'Unknown'`, not `null`/
 * `undefined`, for a row it can't resolve — so `getTypeName(id) || fallback`
 * never falls back: `'Unknown'` is truthy (#4933). Use this wherever an
 * unresolved id should defer to another source, or become `undefined`.
 */

import type { EntityTable } from './entity-table.js';

export function resolvedTypeName(
  entities: Pick<EntityTable, 'getTypeName'>,
  expressId: number,
): string | undefined {
  const name = entities.getTypeName(expressId);
  return name && name !== 'Unknown' ? name : undefined;
}
