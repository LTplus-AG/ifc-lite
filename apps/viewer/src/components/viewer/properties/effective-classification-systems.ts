/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import { extractClassificationSystemsOnDemand, type IfcDataStore } from '@ifc-lite/parser';

/** Metadata and native query consumers share one effective classification reader (#7131). */
export function effectiveClassificationSystems(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
): { names: string[]; unresolved: boolean } {
  return extractClassificationSystemsOnDemand(store, view ?? undefined);
}
