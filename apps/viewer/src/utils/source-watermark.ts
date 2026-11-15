/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { highestExistingExpressId } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

/** Highest source ID the store holds, including an indexless store's table rows. Shared by the
 *  ownership bound and the allocator floor; cached per store by `highestExistingExpressId`. */
export function sourceWatermark(source: IfcDataStore | null): number {
  return source ? highestExistingExpressId(source) : 0;
}
