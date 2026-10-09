/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import { extractStructuralOnDemand, type IfcDataStore, type StructuralExtraction } from '@ifc-lite/parser';
import { effectiveStructuralView } from './effectiveStructuralView';

const cache = new WeakMap<IfcDataStore, { view: MutablePropertyView | null | undefined; revision: number | undefined;
  source: IfcDataStore['source']; data: StructuralExtraction }>();
/** Properties, SDK and evidence share current native structural records (#7195). */
export function effectiveStructuralData(store: IfcDataStore, view: MutablePropertyView | null | undefined): StructuralExtraction {
  const revision = view?.getMutationRevision();
  const current = cache.get(store);
  if (current && current.view === view && current.revision === revision && current.source === store.source) return current.data;
  const data = extractStructuralOnDemand(store, effectiveStructuralView(view, store));
  cache.set(store, { view, revision, source: store.source, data });
  return data;
}
