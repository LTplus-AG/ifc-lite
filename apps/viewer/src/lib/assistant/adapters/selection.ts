/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The current selection as evidence (#6833): each selected element's
 * attributes, property sets and quantity sets as the Properties panel shows
 * them, edits included. Values come from `effectiveElementData` (the reader
 * the multi-selection summary uses) and are formatted with the panel's own
 * display contract (`propertyDisplayValue`, `resolveQuantityDisplay`, with
 * the user's display-unit overrides), so evidence and panel agree.
 *
 * The selection is read the way the Properties panel resolves it: a unified
 * storey selection, then the multi-model ref set, then the renderer id set,
 * then the primary element. Only the first `limit` elements are read; every
 * total is over the whole selection.
 */

import { IfcQuery } from '@ifc-lite/query';
import { extractProjectUnits, ProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';
import type { EntityRef } from '@/store/types';
import { stringToEntityRef } from '@/store/entity-ref';
import { resolveEntityRef, resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';
import { resolveQuantityDisplay } from '@/lib/units/display';
import { effectiveElementData } from '@/components/viewer/properties/effectiveElementData';
import { effectiveSelectedClass } from '@/components/viewer/properties/effectiveSelectedClass';
import { propertyDisplayValue } from '@/components/viewer/properties/propertyDisplayValue';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

type Channel = 'storeys' | 'multi' | 'renderer-ids' | 'single';
const VALUE_CHARS = 240;

/** Cheap: sizes only, in the panel's precedence. */
function selectionSize(s: ViewerState): number {
  if (s.selectedEntities.length > 1) return s.selectedEntities.length;
  if (s.selectedEntitiesSet.size > 1) return s.selectedEntitiesSet.size;
  if (s.selectedEntityIds.size > 1) return s.selectedEntityIds.size;
  return s.selectedEntityId !== null ? 1 : 0;
}

function selectionRefs(s: ViewerState): { channel: Channel; refs: EntityRef[] } | null {
  if (s.selectedEntities.length > 1) return { channel: 'storeys', refs: s.selectedEntities };
  if (s.selectedEntitiesSet.size > 1) {
    return { channel: 'multi', refs: [...s.selectedEntitiesSet].map(stringToEntityRef).filter(ref => ref.expressId > 0) };
  }
  if (s.selectedEntityIds.size > 1) return { channel: 'renderer-ids', refs: [...s.selectedEntityIds].map(resolveEntityRef) };
  if (s.selectedEntityId === null) return null;
  return { channel: 'single', refs: [s.selectedEntity ?? resolveEntityRef(s.selectedEntityId)] };
}

const isLegacy = (modelId: string) => modelId === 'legacy' || modelId === '__legacy__';

interface ModelSource { store: IfcDataStore | null; view: MutablePropertyView | undefined; query: IfcQuery | null; units: ProjectUnits; name: string }

function sources(s: ViewerState) {
  const cache = new Map<string, ModelSource>();
  return (modelId: string): ModelSource => {
    const cached = cache.get(modelId);
    if (cached) return cached;
    const model = isLegacy(modelId) ? undefined : s.models.get(modelId);
    const store = (model?.ifcDataStore ?? (isLegacy(modelId) ? s.ifcDataStore : null)) as IfcDataStore | null;
    const source = {
      store, view: s.mutationViews.get(isLegacy(modelId) ? '__legacy__' : modelId) ?? undefined,
      query: store ? new IfcQuery(store) : null,
      units: store?.source?.length && store.entityIndex ? extractProjectUnits(store.source, store.entityIndex) : ProjectUnits.empty(),
      name: model?.name ?? modelId,
    };
    cache.set(modelId, source);
    return source;
  };
}

function bounded(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS)}…` : text;
}

function elementRow(s: ViewerState, ref: EntityRef, source: ModelSource, rich: boolean) {
  const setLimit = rich ? 16 : 6;
  const valueLimit = rich ? 32 : 12;
  const data = effectiveElementData(ref.expressId, source.query, source.view);
  const attributes = Object.fromEntries([...data.attributes].slice(0, rich ? 32 : 12).map(([name, value]) => [name, bounded(value)]));
  const psets = data.psets.slice(0, setLimit).map(pset => ({
    name: pset.name, propertyCount: pset.properties.length,
    properties: Object.fromEntries(pset.properties.slice(0, valueLimit)
      .map(prop => [prop.name, bounded(propertyDisplayValue(prop, source.units, s.unitDisplayOverrides).full)])),
  }));
  const quantities = data.qsets.slice(0, setLimit).map(qset => ({
    name: qset.name, quantityCount: qset.quantities.length,
    quantities: Object.fromEntries(qset.quantities.slice(0, valueLimit).map(q => {
      if (!Number.isFinite(q.value)) return [q.name, { value: null, unit: null }];
      const display = resolveQuantityDisplay(q.value, q.type, source.units, s.unitDisplayOverrides);
      // A null unit is undeclared, never assumed.
      return [q.name, { value: display.converted ?? q.value, unit: display.unit ?? null }];
    })),
  }));
  const name = data.attributes.get('Name');
  return evidenceRow({
    kind: 'selected-element', modelId: ref.modelId,
    globalId: resolveEntityRefGlobalIdFromState(s, ref), expressId: ref.expressId,
    status: source.view?.hasChanges(ref.expressId) ? 'edited' : 'as-loaded',
  }, {
    modelName: source.name,
    type: effectiveSelectedClass(source.store, source.view, ref.expressId),
    name: typeof name === 'string' && name.length > 0 ? bounded(name) : null,
    attributes, psets, psetCount: data.psets.length, quantities, qsetCount: data.qsets.length,
  });
}

export const selectionAdapter: EvidenceAdapter = {
  id: 'selection', group: 'model', panelIds: ['properties', 'hierarchy'],
  titleKey: 'assistantSources.selection.title', descriptionKey: 'assistantSources.selection.description',
  rowMeaningKey: 'assistantSources.selection.rows', unavailableKey: 'assistantSources.selection.unavailable',
  suggestionKeys: ['assistantSources.selection.suggestExplain', 'assistantSources.selection.suggestCompare'],
  readiness: s => {
    const size = selectionSize(s);
    return size > 0 ? { status: { labelKey: 'assistantSources.selection.ready', params: { count: size } }, ready: true }
      : { status: { labelKey: 'assistantSources.selection.none' }, ready: false };
  },
  // Every selection action replaces one of these; edits are covered by the context stamp.
  identity: s => [s.selectedEntities, s.selectedEntitiesSet, s.selectedEntityIds, s.selectedEntity, s.selectedEntityId],
  capture: (s, limit) => {
    const selection = selectionRefs(s);
    if (!selection || selection.refs.length === 0) return unavailableCapture();
    const { refs, channel } = selection;
    const sourceFor = sources(s);
    const byModel = new Map<string, number>();
    const byClass = new Map<string, number>();
    for (const ref of refs) {
      byModel.set(ref.modelId, (byModel.get(ref.modelId) ?? 0) + 1);
      const source = sourceFor(ref.modelId);
      const type = effectiveSelectedClass(source.store, source.view, ref.expressId) ?? 'Unknown';
      byClass.set(type, (byClass.get(type) ?? 0) + 1);
    }
    const sample = refs.slice(0, limit);
    const rich = sample.length <= 10;
    return {
      summary: {
        kind: 'selection', channel, selectionSize: refs.length, modelCount: byModel.size,
        byModel: [...byModel].map(([modelId, count]) => ({ modelId, name: sourceFor(modelId).name, count })),
        byClass: [...byClass].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
        perElementBounds: rich ? { sets: 16, valuesPerSet: 32, attributes: 32 } : { sets: 6, valuesPerSet: 12, attributes: 12 },
        units: 'Quantity values carry {value, unit} in the Properties panel display unit (project unit, or the display-unit override below); a null unit is undeclared. Property values are the panel display strings, with the unit inline when the measure declares one.',
        displayUnitOverrides: s.unitDisplayOverrides,
        limitations: 'Values include unsaved edits made this session (status "edited"). Property and quantity sets are bounded per element (see perElementBounds; propertyCount/quantityCount/psetCount/qsetCount are the full counts). Type-inherited property sets, materials, classifications and relationships are not included. Only the first elements of a large selection are read; byClass/byModel cover the whole selection.',
      },
      rows: sample.map(ref => elementRow(s, ref, sourceFor(ref.modelId), rich)),
      totalRows: refs.length, availability: 'available',
    };
  },
};
