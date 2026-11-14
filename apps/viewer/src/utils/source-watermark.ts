/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { highestExistingExpressId } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

/** Highest source ID the store holds. Shared by the ownership bound and the allocator floor.
 *  An indexless store (IFCX, collab tables) still owns its table rows; a test double owns none. */
export function sourceWatermark(source: IfcDataStore | null): number {
  if (!source) return 0;
  // @raw-entity-enumeration-ok ownership watermark over the immutable source index; tombstones never free an id
  if (source.entityIndex?.byId) return highestExistingExpressId(source);
  let max = 0;
  // @raw-entity-enumeration-ok load-time ownership watermark over table-only ids, before any overlay is installed
  for (const id of source.entities?.expressId ?? []) if (id > max) max = id;
  return max;
}
