/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { evaluateFilterRulesFederated } from '../search/filter-evaluate.js';
import { ownAppearanceQuery } from './query-definition.js';
import { appearanceScope } from './scope.js';
import type { AppearanceScope } from './draft-types.js';
import type { AppearanceSnapshot } from './snapshot.js';

const parsedSnapshots = new WeakMap<AppearanceSnapshot, IfcDataStore>();
/** Query the exact effective IFC already exported for native planning. This is
 * metadata evaluation only: it never publishes a model or ingests geometry. */
export async function resolveAppearanceScope(snapshot: AppearanceSnapshot, selectedIds: readonly number[],
  scope: AppearanceScope, signal: AbortSignal) {
  const check = () => {
    if (signal.aborted) throw new DOMException('Appearance scope preparation was cancelled.', 'AbortError');
    snapshot.validate();
  };
  check();
  const result = appearanceScope(snapshot.catalog, selectedIds, scope);
  if (scope.kind !== 'filter') return result;
  const query = ownAppearanceQuery(scope.query);
  if (snapshot.bytes.byteLength > 128 * 1024 * 1024 || snapshot.productIds.length > 10_000) {
    throw new Error('The effective IFC exceeds the appearance query budget.');
  }
  const model = useViewerStore.getState().models.get(snapshot.modelId);
  if (!model) throw new Error('The query model is no longer loaded.');
  if (query.rules.some(rule => rule.kind === 'model') && !model.sourceFingerprint) {
    throw new Error('The model source identity is unavailable. Review the filter after reloading the model.');
  }
  let data = parsedSnapshots.get(snapshot);
  if (!data) {
    data = await new IfcParser().parseColumnar(snapshot.bytes.slice().buffer,
      { disableWorkerScan: true, onProgress: check });
    check();
    parsedSnapshots.set(snapshot, data);
  }
  const matches = await evaluateFilterRulesFederated(
    [{ id: snapshot.modelId, filterIdentity: model.sourceFingerprint, store: data }], query.rules, query.combinator,
    { signal, limit: snapshot.productIds.length + 1, chunkSize: 128,
      candidateExpressIdsByModel: new Map([[snapshot.modelId, snapshot.productIds]]) });
  check();
  const candidates = new Set(snapshot.productIds);
  if (matches.some(match => match.modelId !== snapshot.modelId || !candidates.has(match.expressId))) {
    throw new Error('The query returned an object outside its captured model scope.');
  }
  return { ...result, productIds: [...new Set(matches.map(match => match.expressId))].sort((a, b) => a - b) };
}
