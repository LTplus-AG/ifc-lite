/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { alignElementsInStore, alignmentStoreyInStore, type AlignMode, type PlanBox } from '@ifc-lite/create';
import type { CostStoreModelResolution } from './cost-store-backend.js';
import type { EntityRef } from './types.js';

export type AlignGeometryProvider = (model: CostStoreModelResolution, storeyId: number, ids: readonly number[]) => Promise<ReadonlyMap<number, PlanBox>>;
export interface AlignCommandHost {
  historyHead(modelId: string): string;
  record<T>(modelId: string, write: (model: CostStoreModelResolution) => T): T;
}

/** Native preparation completes before the one synchronous atomic history record. */
export function createAlignCommandBackend(resolve: (modelId: string) => CostStoreModelResolution, provide: AlignGeometryProvider, host: AlignCommandHost) {
  const preparing = new Set<string>();
  const journal = (model: CostStoreModelResolution) => model.mutationView.getMutations().map(m => m.id).join('|');
  return {
    async alignElements(modelId: string, reference: number, targets: readonly number[], mode: AlignMode): Promise<EntityRef[]> {
      if (preparing.has(modelId)) throw new Error('Another Align command is preparing this model');
      preparing.add(modelId);
      try {
        const model = resolve(modelId), head = host.historyHead(modelId), changes = journal(model);
        const params = { reference, targets: [...targets], mode };
        const storey = alignmentStoreyInStore({ dataStore: model.store, view: model.mutationView }, params);
        const boxes = await provide(model, storey, [reference, ...params.targets]);
        const current = resolve(modelId);
        if (current.store !== model.store || current.mutationView !== model.mutationView || head !== host.historyHead(modelId) || changes !== journal(current)) throw new Error('The model changed while native Align geometry was preparing; retry the command');
        const result = host.record(modelId, draft => draft.editor.runAtomic(editor => alignElementsInStore({ dataStore: draft.store, view: editor.getMutationView(), editor }, params, boxes)));
        return result.remesh.map(expressId => ({ modelId, expressId }));
      } finally { preparing.delete(modelId); }
    },
  };
}
