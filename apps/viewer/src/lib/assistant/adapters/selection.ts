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
import { extractClassificationsOnDemand, extractProjectUnits, materialAssignmentsAvailable, ProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type ViewerState } from '@/store';
import { createQueryAdapter } from '@/sdk/adapters/query-adapter';
import { relationshipsForSelection } from '@/components/viewer/properties/merge-relationship-data';
import { relationshipPopulationUnavailable } from '@/components/viewer/properties/effective-relationship-availability';
import type { EntityRef } from '@/store/types';
import { stringToEntityRef } from '@/store/entity-ref';
import { toGlobalIdForRef } from '@/store/globalId';
import { resolveEntityRef, resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';
import { resolveQuantityDisplay } from '@/lib/units/display';
import { effectiveElementData } from '@/components/viewer/properties/effectiveElementData';
import { classificationPopulationUnavailable } from '@/components/viewer/properties/effective-classification-systems';
import { effectiveMaterials, effectiveMaterialProperties } from '@/components/viewer/properties/effectiveMaterials';
import { materialEvidence } from './selection-materials';
import { documentEvidence } from './selection-documents';
import { structuralEvidence } from './selection-structural';
import { effectiveStructuralData } from '@/components/viewer/properties/effectiveStructuralData';
import { effectiveDocuments } from '@/components/viewer/properties/effectiveDocuments';
import { classificationEvidence } from './selection-classifications';
import { selectedZoneVolumeBreakdowns, zoneQuantitySources } from './zone-volume-bases';
import { effectiveTypeProperties } from '@/components/viewer/properties/effectiveTypeProperties';
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
  return singleRef(s) ? 1 : 0;
}

/**
 * The one selected element, from whichever channel holds it: multi-model actions write `selectedEntity`
 * without `selectedEntityId` (the Properties panel reads `selectedEntity`), and a one-element storey or
 * multi-model set is a single selection too.
 */
function singleRef(s: ViewerState): EntityRef | null {
  if (s.selectedEntity) return s.selectedEntity;
  if (s.selectedEntities.length === 1) return s.selectedEntities[0];
  if (s.selectedEntitiesSet.size === 1) {
    const ref = stringToEntityRef([...s.selectedEntitiesSet][0]);
    if (ref.expressId > 0) return ref;
  }
  return s.selectedEntityId !== null ? resolveEntityRef(s.selectedEntityId) : null;
}

function selectionRefs(s: ViewerState): { channel: Channel; refs: EntityRef[] } | null {
  if (s.selectedEntities.length > 1) return { channel: 'storeys', refs: s.selectedEntities };
  if (s.selectedEntitiesSet.size > 1) {
    return { channel: 'multi', refs: [...s.selectedEntitiesSet].map(stringToEntityRef).filter(ref => ref.expressId > 0) };
  }
  if (s.selectedEntityIds.size > 1) return { channel: 'renderer-ids', refs: [...s.selectedEntityIds].map(resolveEntityRef) };
  const single = singleRef(s);
  return single ? { channel: 'single', refs: [single] } : null;
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

function elementRow(s: ViewerState, ref: EntityRef, source: ModelSource, rich: boolean,
  quantitySource: ReturnType<typeof zoneQuantitySources>) {
  const setLimit = rich ? 16 : 6;
  const relationshipLookupExpressId = source.view?.resolveBaseEntityId(ref.expressId) ?? ref.expressId;
  const nativeRelationships = source.store ? relationshipsForSelection(
    createQueryAdapter({ getState: () => s, subscribe: useViewerStore.subscribe }).relationships,
    ref, relationshipLookupExpressId).relations ?? [] : [];
  const relationshipsUnavailable = relationshipPopulationUnavailable(source.store, source.view);
  const valueLimit = rich ? 32 : 12;
  const data = effectiveElementData(ref.expressId, source.query, source.view);
  const structuralData = source.store ? effectiveStructuralData(source.store, source.view) : null;
  const { rows: documents, membershipUnavailable: documentsUnavailable } = effectiveDocuments(source.store, ref.expressId, source.view);
  const classifications = source.store ? extractClassificationsOnDemand(source.store, ref.expressId, source.view) : [];
  const classificationsUnavailable = classificationPopulationUnavailable(source.store, source.view);
  const materials = effectiveMaterials(source.store, ref.expressId, source.view);
  const materialAssignmentsVerified = Boolean(source.store && materialAssignmentsAvailable(source.store, ref.expressId, source.view));
  const materialPropertiesVerified = materialAssignmentsVerified && Boolean(source.store?.source?.length) && !materials.some(material => material.unresolved);
  const materialProperties = effectiveMaterialProperties(source.store, ref.expressId, source.view, s.mutationVersion);
  const attributes = Object.fromEntries([...data.attributes].slice(0, rich ? 32 : 12).map(([name, value]) => [name, bounded(value)]));
  const inherited = effectiveTypeProperties(source.store, ref.expressId, source.view);
  const typeAttributes = inherited ? source.view?.getAttributeMutationsForEntity(inherited.typeId) ?? [] : [];
  const typeGlobalId = inherited ? typeAttributes.find(attr => attr.name === 'GlobalId')?.value
    ?? source.store?.entities.getGlobalId(inherited.typeId) : null;
  const typeName = inherited ? typeAttributes.find(attr => attr.name === 'Name')?.value
    ?? source.store?.entities.getName(inherited.typeId) : null;
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
  const zoneQuantities = quantitySource(ref);
  return evidenceRow({
    kind: 'selected-element', modelId: ref.modelId,
    globalId: resolveEntityRefGlobalIdFromState(s, ref), expressId: ref.expressId,
    status: source.view?.hasChanges(ref.expressId) ? 'edited' : 'as-loaded',
  }, {
    modelName: source.name,
    type: effectiveSelectedClass(source.store, source.view, ref.expressId),
    name: typeof name === 'string' && name.length > 0 ? bounded(name) : null,
    attributes, psets, psetCount: data.psets.length, quantities, qsetCount: data.qsets.length,
    zoneVolumeBreakdowns: { quantityStatus: zoneQuantities.status,
      ...selectedZoneVolumeBreakdowns(s, toGlobalIdForRef(s.models, ref),
        zoneQuantities.quantities, zoneQuantities.scale, setLimit, valueLimit) },
    structuralStatus: !source.store ? 'unavailable' : source.store.source?.length ? 'available' : 'unavailable-source',
    structural: structuralEvidence(structuralData, ref.expressId, typeof data.attributes.get('GlobalId') === 'string'
      ? String(data.attributes.get('GlobalId')) : undefined, setLimit, valueLimit, source.units, source.store?.schemaVersion, Boolean(source.store?.source?.length)),
    documentStatus: !source.store ? 'unavailable' : documentsUnavailable ? 'unavailable-source-membership' : 'available',
    documentCount: !source.store || documentsUnavailable ? null : documents.length,
    documents: documents.slice(0, setLimit).map(document => documentEvidence(document, source.store?.schemaVersion)),
