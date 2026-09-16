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
import { extractProjectUnits, measureUnit, type ProjectUnits } from '@ifc-lite/parser';
import type { ColumnDefinition } from '@ifc-lite/lists';
import { resolveListColumnUnits, sourceUnitSymbolForMeasure } from '@/lib/units/list-column-units';
import { alternativesForUnitType } from '@/lib/units/alternatives';
import { convertValue } from '@/lib/units/convert';

type ModelsState = Pick<ViewerState, 'models' | 'activeModelId' | 'pinboardEntities' | 'mutationViews' | 'mutationVersion' | 'unitDisplayOverrides'>;

function isFieldList(value: readonly ElementFieldBinding[] | ModelsState): value is readonly ElementFieldBinding[] {
  return Array.isArray(value);
}

function hasSourceUnit(units: ProjectUnits | undefined, unitType: string): boolean {
  if (!units) return false;
  if (units.resolvedForUnitType(unitType)) return true;
  return (unitType === 'AREAUNIT' || unitType === 'VOLUMEUNIT') && Boolean(units.resolvedForUnitType('LENGTHUNIT'));
}

/** Per-model include sets for a scope, or `null` for "every element". */
function includeSets(scope: ChartScope, state: ModelsState): Map<string, Set<number>> | null {
  let refs: EntityRef[];
  if (scope.kind === 'visible') refs = getVisibleBasketEntityRefsFromStore();
  else if (scope.kind === 'basket') refs = [...state.pinboardEntities].map(stringToEntityRef);
  else return null; // 'all' — a 'list' scope is resolved by the caller into rows, not an include set
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
  const unitColumns: ColumnDefinition[] = fields.map((field, index) => ({
    id: String(index),
    source: field.kind,
    propertyName: field.kind === 'attribute' ? field.attributeName : field.propertyName,
    ...(field.kind === 'property' ? { psetName: field.psetName } : {}),
    ...(field.dataType ? { dataType: field.dataType } : {}),
  }));
  const modelUnits = new Map();
  for (const model of state.models.values()) {
    const store = model.ifcDataStore;
    if (store?.source?.length && store.entityIndex) modelUnits.set(model.id, extractProjectUnits(store.source, store.entityIndex));
  }
  const unitResolver = resolveListColumnUnits(unitColumns, modelUnits, state.unitDisplayOverrides);
  const resolvedFields = fields.map((field, index) => {
    const measure = field.dataType ? measureUnit(field.dataType) : undefined;
    const hasDeclaredUnits = measure?.kind === 'typed' && [...modelUnits.values()].some((units) => hasSourceUnit(units, measure.unitType));
    const hasOverride = measure?.kind === 'typed' && state.unitDisplayOverrides[measure.unitType] !== undefined;
    const unit = field.unit || hasDeclaredUnits || hasOverride ? (unitResolver.unitSymbol(index) ?? field.unit) : undefined;
    return { ...field, ...(unit ? { unit } : {}) };
  });
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
          const index = resolvedFields.findIndex((candidate) => elementFieldColumnId(candidate) === elementFieldColumnId(field));
          const cell = reader.readResolved(expressId, field);
          if (cell.status !== 'value' || index < 0) return cell;
          const declaredType = cell.dataType?.toUpperCase();
          const bindingType = field.dataType?.toUpperCase();
          const declaredKind = declaredType ? measureUnit(declaredType) : undefined;
          const bindingKind = bindingType ? measureUnit(bindingType) : undefined;
          if (field.valueKind === 'number' && !bindingType && declaredKind?.kind === 'typed') {
            return { value: null, status: 'unsupported' as const };
          }
          if (bindingType && declaredType && bindingType !== declaredType
            && !(declaredKind?.kind === 'typed' && bindingKind?.kind === 'typed' && declaredKind.unitType === bindingKind.unitType)) {
            return { value: null, status: 'unsupported' as const };
          }
          if (field.valueKind === 'category') {
            const projectUnits = modelUnits.get(modelId);
            const sourceSymbol = projectUnits && declaredType ? sourceUnitSymbolForMeasure(projectUnits, declaredType) : undefined;
            const suffix = cell.unit ?? sourceSymbol ?? (declaredKind?.kind === 'typed' ? cell.dataType : undefined);
            return { ...cell, value: suffix ? `${cell.value} ${suffix}` : cell.value };
          }
          if (typeof cell.value !== 'number') return cell;
          if (cell.unit) {
            const kind = declaredKind?.kind === 'typed' ? declaredKind : bindingKind?.kind === 'typed' ? bindingKind : undefined;
            const targetSymbol = resolvedFields[index]?.unit;
            const source = kind ? alternativesForUnitType(kind.unitType).find((unit) => unit.symbol === cell.unit) : undefined;
            const target = kind && targetSymbol ? alternativesForUnitType(kind.unitType).find((unit) => unit.symbol === targetSymbol) : undefined;
            if (!source || !target) return { value: null, status: 'unsupported' as const };
            return { value: convertValue(cell.value, source, target), status: 'value' as const };
          }
          const projectUnits = modelUnits.get(modelId);
          const unitKind = declaredKind?.kind === 'typed' ? declaredKind : bindingKind?.kind === 'typed' ? bindingKind : undefined;
          if (unitKind && !hasSourceUnit(projectUnits, unitKind.unitType)) {
            return { value: null, status: 'unsupported' as const };
          }
          return { ...cell, value: unitResolver.convertCell(index, cell.value, modelId) };
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
