/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `elements` chart dataset from the loaded federation (#3944).
 *
 * One row per element instance across every loaded model, through the
 * package's typed-array fast path (`elementsDataset`), with the dashboard
 * scope applied as an include-set per model: everything, what is visible
 * right now (the same answer the lists "visible only" filter gives), or the
 * basket. Rows carry renderer ids through the store's federation rule
 * (`toGlobalIdFromModels`), so a bucket's ids go straight to selection and
 * visibility.
 */
import { elementFieldColumnId, elementsDataset, type ChartDataset, type ChartScope, type ElementFieldBinding, type ElementsDatasetModel } from '@ifc-lite/charts';
import { useViewerStore, type ViewerState } from '@/store';
import { getVisibleBasketEntityRefsFromStore } from '@/store/basketVisibleSet';
import { toGlobalIdFromModels } from '@/store/globalId';
import { stringToEntityRef, type EntityRef } from '@/store/types';
import { createElementFieldReader } from '@/lib/charts/element-field-reader';
import { resolveFieldCell, resolveFieldColumnUnit } from '@/lib/charts/element-field-units';
import { extractProjectUnits, type ProjectUnits } from '@ifc-lite/parser';
import type { ColumnDefinition } from '@ifc-lite/lists';
import { resolveListColumnUnits } from '@/lib/units/list-column-units';

type ModelsState = Pick<ViewerState, 'models' | 'activeModelId' | 'pinboardEntities' | 'mutationViews' | 'mutationVersion' | 'unitDisplayOverrides'>;

function isFieldList(value: readonly ElementFieldBinding[] | ModelsState): value is readonly ElementFieldBinding[] {
  return Array.isArray(value);
}

/** Per-model include sets for a scope, or `null` for "every element". */
function includeSets(scope: ChartScope, state: ModelsState): Map<string, Set<number>> | null {
  let refs: EntityRef[];
  if (scope.kind === 'visible') refs = getVisibleBasketEntityRefsFromStore();
  else if (scope.kind === 'basket') refs = [...state.pinboardEntities].map(stringToEntityRef);
  else return null; // 'all' — no include set; a per-chart source filter (#4946) narrows rows separately
  const sets = new Map<string, Set<number>>();
  for (const ref of refs) {
    // Single-model rows are keyed 'legacy'/'default' by their producers while
    // `models` keys the same model by its id; fold them onto the active model.
    const modelId = state.models.has(ref.modelId) ? ref.modelId : (state.activeModelId ?? ref.modelId);
    let set = sets.get(modelId);
    if (!set) {
      set = new Set();
      sets.set(modelId, set);
    }
    set.add(ref.expressId);
  }
  return sets;
}

export function buildElementsDataset(scope: ChartScope, state?: ModelsState): ChartDataset;
export function buildElementsDataset(scope: ChartScope, fields: readonly ElementFieldBinding[], state?: ModelsState): ChartDataset;
export function buildElementsDataset(
  scope: ChartScope,
  fieldsOrState: readonly ElementFieldBinding[] | ModelsState = [],
  explicitState?: ModelsState,
): ChartDataset {
  const fields = isFieldList(fieldsOrState) ? fieldsOrState : [];
  const state = (isFieldList(fieldsOrState) ? explicitState : fieldsOrState) ?? useViewerStore.getState();
  const includes = includeSets(scope, state);
  // One target unit per numeric field for the whole federation, through the
  // same resolver the Lists table sums with; each cell is converted from the
  // unit it is actually in (see `element-field-units`).
  const unitColumns: ColumnDefinition[] = fields.map((field, index) => ({
    id: String(index),
    // Only `dataType` drives the resolver; source and names are descriptive.
    source: field.kind === 'type' ? 'attribute' : field.kind,
    propertyName: field.kind === 'attribute' ? field.attributeName
      : field.kind === 'property' ? field.propertyName
        : field.kind === 'quantity' ? field.quantityName
          : field.kind === 'spatial' ? field.level
            : field.kind === 'type' ? 'Type' : field.kind,
    ...(field.kind === 'property' ? { psetName: field.psetName } : field.kind === 'quantity' ? { psetName: field.qsetName } : {}),
    ...(field.dataType ? { dataType: field.dataType } : {}),
  }));
  const modelUnits = new Map<string, ProjectUnits>();
  for (const model of state.models.values()) {
    const store = model.ifcDataStore;
    if (store?.source?.length && store.entityIndex) modelUnits.set(model.id, extractProjectUnits(store.source, store.entityIndex));
  }
  const resolver = resolveListColumnUnits(unitColumns, modelUnits, state.unitDisplayOverrides);
  const resolvedFields = fields.map((field, index) => {
    const unit = resolveFieldColumnUnit(field, index, modelUnits, resolver);
    return { ...field, ...(unit ? { unit } : {}) };
  });
  const fieldIndex = new Map(resolvedFields.map((field, index) => [elementFieldColumnId(field), index]));
  const models: ElementsDatasetModel[] = [];
  for (const model of state.models.values()) {
    const store = model.ifcDataStore;
    if (!store) continue;
    const include = includes?.get(model.id) ?? (includes ? new Set<number>() : undefined);
    // The store's federation id rule, not offset arithmetic of our own.
    const modelId = model.id;
    const reader = resolvedFields.length > 0 ? createElementFieldReader(store, state.mutationViews.get(modelId)) : undefined;
    models.push({
      store,
      toGlobalId: (expressId) => toGlobalIdFromModels(state.models, modelId, expressId),
      name: model.name ?? modelId,
      include,
      ...(reader ? {
        readField: (expressId, field) => {
          const index = fieldIndex.get(elementFieldColumnId(field)) ?? -1;
          const cell = reader.readResolved(expressId, field);
          if (index < 0) return cell;
          return resolveFieldCell(cell, { field, index, columnUnit: resolvedFields[index].unit, modelId, projectUnits: modelUnits.get(modelId), resolver });
        },
        valueRevision: `${model.sourceFingerprint ?? model.sourceContentHash ?? model.loadedAt}:${state.mutationVersion}:${JSON.stringify(state.unitDisplayOverrides)}`,
      } : {}),
    });
  }
  const dataset = elementsDataset(models, resolvedFields);
  // The scope is part of the identity of the rows: the same models with a
  // different include set are a different dataset.
  return { ...dataset, fingerprint: `${scope.kind}:${dataset.fingerprint}` };
}
