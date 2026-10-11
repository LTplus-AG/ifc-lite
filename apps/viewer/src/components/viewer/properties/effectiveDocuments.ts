/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import { extractDocumentsOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { documentPopulationUnavailable } from './effective-document-availability';

/** Native Properties and selected evidence share reader and availability (#7187). */
export function effectiveDocuments(store: IfcDataStore | null | undefined, expressId: number | undefined,
  view: MutablePropertyView | null | undefined) {
  return { rows: store && expressId !== undefined ? extractDocumentsOnDemand(store, expressId, view ?? undefined) : [],
    membershipUnavailable: documentPopulationUnavailable(store, view) };
}
