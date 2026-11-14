/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { highestExistingExpressId } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

/** Highest source ID the store holds (0 without an index). Shared by the ownership bound and the allocator floor. */
export function sourceWatermark(source: IfcDataStore | null): number {
  return source?.entityIndex?.byId ? highestExistingExpressId(source) : 0;
}
