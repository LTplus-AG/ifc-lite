/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createCostBackend, createCostStoreBackend, resolveLiveOwnerHistoryId } from '@ifc-lite/sdk';
import type { CostScheduleParams, CostItemParams, CostValueParams, CostQuantityParams } from '@ifc-lite/create';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { costRef, type CostOperation, type CostProposal, type CostRef } from './cost-graph-proposal';
import type { CostSnapshot } from './cost-graph-evidence';
import { uniqueSplitGuid } from './model-authoring-split';
import { liveEntityConforms } from '@ifc-lite/create';
import { effectiveMetadataRecord } from '@ifc-lite/parser';

export interface CostWriteRow { index: number; expressId: number | null }
/** Existing references must be present in the complete supplied native snapshot, never guessed IDs. */
export function writeCostOperations(state: Pick<ViewerState, 'models' | 'mutationViews'>, target: ModelEditTarget,
  draft: StoreEditor, proposal: CostProposal, snapshot: CostSnapshot, approved: ReadonlySet<number>): CostWriteRow[] {
  const { modelId, dataStore } = target, view = draft.getMutationView();
  const backend = createCostBackend(() => ({ modelId, store: dataStore, mutationView: view }));
  const write = createCostStoreBackend(() => ({ modelId, store: dataStore, editor: draft, mutationView: view,
    ownerHistoryId: resolveLiveOwnerHistoryId(dataStore, draft, view),
    globalIdScopes: [...state.models].filter(([id]) => id !== modelId).flatMap(([id, model]) => model.ifcDataStore
      ? [{ dataStore: model.ifcDataStore, view: state.mutationViews.get(id) ?? null }] : []) }), backend);
  const refs = new Map<string, number>();
  const records = new Map(snapshot.records.map(row => [row.expressId, row]));
  const resolved = (value: CostRef) => {
    if (typeof value !== 'number') {
      const id = refs.get(value.ref);
      if (id === undefined) throw new Error(`Approve the earlier creation '${value.ref}' before this dependent operation`);
      return id;
    }
    const record = records.get(value);
    if (!record || view.isDeleted(value)) throw new Error(`Native reference #${value} was not captured or is no longer available`);
    if (liveEntityConforms(dataStore, value, 'IfcRoot', view)) {
      const guid = record.attributes[0];
      if (typeof guid !== 'string' || !uniqueSplitGuid(dataStore, draft, guid)) throw new Error(`Native target #${value} has an unavailable or ambiguous GlobalId`);
    }
    return value;
  };
  const params = (operation: CostOperation) => {
    const result = { ...operation.params };
    for (const key of ['AppliedValueRef', 'UnitBasis', 'Unit']) if (result[key] !== undefined) result[key] = resolved(costRef(result[key], key));
    for (const key of ['CostValues', 'CostQuantities', 'Components']) if (Array.isArray(result[key])) result[key] = result[key].map(item => resolved(costRef(item, key)));
    return result;
  };
  return proposal.operations.flatMap((operation, index): CostWriteRow[] => {
    if (!approved.has(index)) return [];
    let expressId: number | null = null;
    switch (operation.op) {
      // Parsing bounds and validates JSON types; the canonical builders alone validate native enums, IFC SELECTs and ownership.
      case 'cost.schedule.create': expressId = write.addCostSchedule(modelId, params(operation) as unknown as CostScheduleParams).expressId; break;
      case 'cost.item.create': expressId = write.addCostItem(modelId, params(operation) as unknown as CostItemParams).expressId; break;
      case 'cost.value.create': expressId = write.addCostValue(modelId, params(operation) as unknown as CostValueParams).expressId; break;
      case 'cost.quantity.create': expressId = write.addCostQuantity(modelId, params(operation) as unknown as CostQuantityParams).expressId; break;
      case 'cost.items.nest': expressId = write.nestCostItems(modelId, resolved(operation.target!), operation.related!.map(resolved)).expressId; break;
      case 'cost.schedule.assign': expressId = write.assignCostItemsToSchedule(modelId, resolved(operation.target!), operation.related!.map(resolved)).expressId; break;
      case 'cost.item.assign': expressId = write.assignToCostItem(modelId, resolved(operation.target!), operation.related!.map(resolved)).expressId; break;
      case 'cost.item.values': expressId = resolved(operation.target!); write.setCostItemValues(modelId, expressId, operation.related!.map(resolved)); break;
      case 'cost.remove': expressId = resolved(operation.target!); write.removeCostEntity(modelId, expressId, { detach: operation.detach }); break;
    }
    if (expressId !== null && liveEntityConforms(dataStore, expressId, 'IfcRoot', view)) {
      const guid = effectiveMetadataRecord(dataStore, expressId, view)?.attributes[0];
      if (typeof guid !== 'string' || !uniqueSplitGuid(dataStore, draft, guid)) throw new Error('The native Cost result has an ambiguous or unavailable Root identity');
    }
    if (operation.ref) {
      if (expressId === null) throw new Error('This native Cost operation returned no reference');
      refs.set(operation.ref, expressId);
    }
    return [{ index, expressId }];
  });
}
