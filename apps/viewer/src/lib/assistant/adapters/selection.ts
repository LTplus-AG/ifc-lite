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

import { nativeAuthoringEvidence } from '@/lib/actions/native-authoring-evidence';
import { IfcQuery } from '@ifc-lite/query';
import { extractClassificationsOnDemand, extractProjectUnits, materialAssignmentsAvailable, ProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type ViewerState } from '@/store';
import { createQueryAdapter } from '@/sdk/adapters/query-adapter';
import { relationshipsForSelection } from '@/components/viewer/properties/merge-relationship-data';
import { relationshipPopulationUnavailable } from '@/components/viewer/properties/effective-relationship-availability';
import type { EntityRef } from '@/store/types';
import { stringToEntityRef } from '@/store/entity-ref';
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
import { effectiveTypeProperties } from '@/components/viewer/properties/effectiveTypeProperties';
import { effectiveSelectedClass } from '@/components/viewer/properties/effectiveSelectedClass';
import { propertyDisplayValue } from '@/components/viewer/properties/propertyDisplayValue';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';
import { nativeReadTargets } from '@/lib/actions/model-authoring-read-target';
import { nativeEditEvidence, nativeRootName } from '@/lib/actions/native-edit-evidence';
import { nativeTypeEvidence } from '@/lib/actions/native-type-evidence';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';

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

function elementRow(s: ViewerState, ref: EntityRef, source: ModelSource, rich: boolean, nativeTarget: ModelEditTarget | null) {
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
  const name = source.store ? nativeRootName({ dataStore: source.store, view: source.view }, ref.expressId) : data.attributes.get('Name');
  return evidenceRow({
    kind: 'selected-element', modelId: ref.modelId,
    globalId: resolveEntityRefGlobalIdFromState(s, ref), expressId: ref.expressId,
    status: source.view?.hasChanges(ref.expressId) ? 'edited' : 'as-loaded',
  }, {
    modelName: source.name,
    type: effectiveSelectedClass(source.store, source.view, ref.expressId),
    name: typeof name === 'string' && name.length > 0 ? bounded(name) : null,
    ...nativeAuthoringEvidence(nativeTarget, ref.expressId),
    attributes, psets, psetCount: data.psets.length, quantities, qsetCount: data.qsets.length,
    nativeEdit: nativeEditEvidence(nativeTarget, ref.expressId),
    nativeType: nativeTypeEvidence(s, nativeTarget, ref.expressId),
    structuralStatus: !source.store ? 'unavailable' : source.store.source?.length ? 'available' : 'unavailable-source',
    structural: structuralEvidence(structuralData, ref.expressId, typeof data.attributes.get('GlobalId') === 'string'
      ? String(data.attributes.get('GlobalId')) : undefined, setLimit, valueLimit, source.units, source.store?.schemaVersion, Boolean(source.store?.source?.length)),
    documentStatus: !source.store ? 'unavailable' : documentsUnavailable ? 'unavailable-source-membership' : 'available',
    documentCount: !source.store || documentsUnavailable ? null : documents.length,
    documents: documents.slice(0, setLimit).map(document => documentEvidence(document, source.store?.schemaVersion)),
    relationshipLookupExpressId,
    relationshipStatus: !source.store ? 'unavailable' : !relationshipsUnavailable ? 'available'
      : !source.store.relationships ? 'unavailable-membership' : 'unavailable-source-membership',
    relationshipCount: source.store && !relationshipsUnavailable ? nativeRelationships.length : null,
    relationships: nativeRelationships.slice(0, setLimit).map(edge => ({
      relationshipId: edge.relationshipId, relationshipType: edge.relationshipType, direction: edge.direction,
      verification: relationshipsUnavailable || !edge.entity.type || edge.entity.type === 'Unknown' ? 'unverified' : 'resolved',
      entity: { modelId: ref.modelId, expressId: edge.entity.id, Name: bounded(edge.entity.name), type: bounded(edge.entity.type === 'Unknown' ? null : edge.entity.type) },
    })),
    classificationStatus: !source.store ? 'unavailable' : !classificationsUnavailable ? 'available'
      : !source.store.onDemandClassificationMap && !source.store.relationships
        ? 'unavailable-membership' : 'unavailable-source-membership',
    classificationCount: source.store && !classificationsUnavailable ? classifications.length : null,
    classifications: classifications.slice(0, setLimit)
      .map(info => classificationEvidence(info, source.store?.schemaVersion, setLimit)),
    materialsStatus: !source.store ? 'unavailable' : materialAssignmentsVerified ? 'available' : 'unavailable-membership',
    materialCount: materialAssignmentsVerified ? materials.length : null,
    materials: materials.slice(0, setLimit).map(material => materialEvidence(material, valueLimit)),
    materialPropertiesStatus: !source.store?.source?.length ? 'unverified-without-source'
      : materialPropertiesVerified ? 'available' : 'unverified-material-associations',
    materialPropertyGroupCount: materialPropertiesVerified ? materialProperties.length : null,
    materialProperties: materialProperties.slice(0, setLimit).map(group => ({
      modelId: ref.modelId, expressId: group.materialId, displayName: bounded(group.materialName),
      psetCount: materialPropertiesVerified ? group.psets.length : null,
      psets: group.psets.slice(0, setLimit).map(pset => ({
        name: pset.name, propertyCount: materialPropertiesVerified ? pset.properties.length : null,
        properties: Object.fromEntries(pset.properties.slice(0, valueLimit)
          .map(prop => [prop.name, bounded(propertyDisplayValue(prop, source.units, s.unitDisplayOverrides).full)])),
      })),
    })),
    inheritedType: inherited ? {
      modelId: ref.modelId, modelName: source.name,
      GlobalId: typeof typeGlobalId === 'string' && typeGlobalId && typeGlobalId !== '$' ? typeGlobalId : null,
      Name: bounded(typeName === '$' ? '' : typeName), expressId: inherited.typeId,
      status: source.view?.hasChanges(inherited.typeId) ? 'edited' : 'as-loaded',
      psetCount: inherited.psets.length,
      psets: inherited.psets.slice(0, setLimit).map(pset => ({
        name: pset.name, propertyCount: pset.properties.length,
        properties: Object.fromEntries(pset.properties.slice(0, valueLimit)
          .map(prop => [prop.name, bounded(propertyDisplayValue(prop, source.units, s.unitDisplayOverrides).full)])),
      })),
    } : null,
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
  identity: s => [s.selectedEntities, s.selectedEntitiesSet, s.selectedEntityIds, s.selectedEntity, s.selectedEntityId,
    // #7282: native expected pins belong to these exact loaded sources/views,
    // even when a replacement preserves the same GUIDs and analysis versions.
    ...[...new Set((selectionRefs(s)?.refs ?? []).map(ref => ref.modelId))].flatMap(modelId => [
      modelId, isLegacy(modelId) ? s.ifcDataStore : s.models.get(modelId)?.ifcDataStore,
      s.mutationViews.get(isLegacy(modelId) ? '__legacy__' : modelId),
    ]),
  ],
  capture: (s, limit) => {
    const selection = selectionRefs(s);
    if (!selection || selection.refs.length === 0) return unavailableCapture();
    const { refs, channel } = selection;
    const sourceFor = sources(s);
    const nativeTarget = nativeReadTargets(s);
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
        perElementBounds: rich ? { sets: 16, valuesPerSet: 32, attributes: 32, classifications: 16, classificationPath: 16, relationships: 16, documents: 16 }
          : { sets: 6, valuesPerSet: 12, attributes: 12, classifications: 6, classificationPath: 6, relationships: 6, documents: 6 },
        units: 'Quantity values carry {value, unit} in the Properties panel display unit (project unit, or the display-unit override below); a null unit is undeclared. Property values are the panel display strings, with the unit inline when the measure declares one.',
        displayUnitOverrides: s.unitDisplayOverrides,
        limitations: 'Includes native edits; status covers own edits. Definitions/associations use snapshot freshness. Sections use perElementBounds and full known counts. inheritedType has model/type provenance; occurrence properties override same-named type values. Materials prefer occurrence over type; LayerThickness is metres; properties use panel units. IFC2X3 scalar material-property subtypes are outside the generic-set reader. Unverified fields remain unknown; missing membership inputs/unreadable source edits make totals null/unavailable. Source-free classification/document markers describe original source, not current assignments. Paths have bounded known ancestors; unverified path totals are null. Classification codes use schema-exact ItemReference/Identification; missing systems stay unknown. Relationships count exact native edges; aliases carry inherited lookup IDs. Edited source-free graph edges are unverified source-origin evidence. Unverified material-property counts stay null; empty rows do not prove absence. Documents have native model/target IDs and separate bounds. Empty samples do not prove absence. Selection is sampled; byClass/byModel cover every selected element.',
        structuralLimitations: 'Structural rows match the native member card; counts cover resolved native records and units are declared source units only. Load/evidence bounds are explicit. Missing/duplicate native GUID targets are omitted with unknown resolved totals. Source-free original fields/totals are unknown; authored fields remain readable.',
      },
      rows: sample.map(ref => elementRow(s, ref, sourceFor(ref.modelId), rich, nativeTarget(ref.modelId))),
      totalRows: refs.length, availability: 'available',
    };
  },
};
