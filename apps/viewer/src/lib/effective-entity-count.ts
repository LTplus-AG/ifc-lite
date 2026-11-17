/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The size of a model as edited, for the rows that report it. The parsed
 * `entityCount` and the loader's `maxExpressId` describe the file as loaded, and
 * an authored element lives only in the mutation overlay, so they stood still
 * beside a live element count (#9026).
 */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { entityOwnership } from '@/utils/entity-ownership';

type View = Pick<MutablePropertyView, 'getNewEntities' | 'getTombstones'>;

/**
 * Entities in the edited model: the parsed count, plus what the session created
 * and still holds, minus the source entities it deleted. `undefined` when the
 * store reports no count. A created-then-deleted id is tombstoned too but is
 * neither in the source nor in `getNewEntities`, so tombstones are intersected
 * with the source before subtracting (see `MutablePropertyView.deleteEntity`).
 */
export function effectiveEntityCount(store: IfcDataStore | null | undefined, view?: View | null): number | undefined {
  const parsed = store?.entityCount;
  if (parsed == null || !view) return parsed;
  const inSource = entityOwnership(store);
  let deleted = 0;
  for (const id of view.getTombstones()) if (inSource(id)) deleted++;
  return parsed + view.getNewEntities().length - deleted;
}

/**
 * The highest express id in use: the file's, or a higher one the session
 * created. A deleted source id stays the floor, since ids are never reused.
 */
export function effectiveMaxExpressId(fileMax: number, view?: Pick<View, 'getNewEntities'> | null): number {
  let max = fileMax;
  for (const entity of view?.getNewEntities() ?? []) if (entity.expressId > max) max = entity.expressId;
  return max;
}
