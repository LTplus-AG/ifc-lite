/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { StoreEditor } from '@ifc-lite/mutations';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import { resolveSpatialAnchor } from '@ifc-lite/create';
import { iterateEffectiveEntities } from '@ifc-lite/data';
import type { ViewerState } from '@/store';
import { resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';
import { collidesByName } from '@/hooks/useZoneWriteBack';
import { resolveRenderFrame } from '@/hooks/useRenderFrameOffsets';
import { zoneEmissionFrameFor } from '@/hooks/useZoneSpatialZones';
import { zoneEvaluationIsCurrent, currentZoneEvaluationIdentity } from '@/lib/zones/evaluation-owner';
import { removeSpatialZones, type ZoneMembership } from '@/lib/zones/emit-spatial-zones';
import { effectiveCostReferenceOccurrences } from '../../../../../packages/sdk/src/cost-reference-scan.js';
import { readOnlyModelEditLease, nativeLengthUnitAvailable } from './model-authoring-read-target';
import { uniqueSplitGuid } from './model-authoring-split';
export function readZoneEmissionSnapshot(state: ViewerState, modelId: string, zoneSetId: string, storeyId: number, initializingModel?: string) {
  if (!zoneEvaluationIsCurrent(state, initializingModel)) throw new Error('The native zone evaluation is unavailable or changed; recompute in the Zones panel before attaching');
  const model = state.models.get(modelId), lease = readOnlyModelEditLease(state, modelId), set = state.zoneSets.find(row => row.id === zoneSetId);
  if (!model || !lease || !set || !lease.target.dataStore.source.byteLength || collidesByName(set)) throw new Error('The explicit model, unique current zone set or source is unavailable');
  if (state.zoneSets.filter(row => row.id === zoneSetId).length !== 1 || set.zones.length > 100 || !set.zones.length) throw new Error('Choose one unique bounded existing zone set');
  const target = lease.target, { dataStore, view, editor } = target;
  if (!nativeLengthUnitAvailable(target)) throw new Error('Native model length units are unavailable');
  const anchor = resolveSpatialAnchor(dataStore, storeyId, view);
  if (anchor.schema !== 'IFC4' && anchor.schema !== 'IFC4X3') throw new Error('IfcSpatialZone requires declared IFC4 or IFC4X3');
  const storey = effectiveMetadataRecord(dataStore, storeyId, view);
  if (storey?.type !== 'IfcBuildingStorey') throw new Error('Choose one current native storey');
  const identity = (expressId: number) => {
    const record = effectiveMetadataRecord(dataStore, expressId, view), GlobalId = resolveEntityRefGlobalIdFromState(state, { modelId, expressId });
    if (!record || !GlobalId || !/^[0-3][0-9A-Za-z_$]{21}$/.test(GlobalId) || !uniqueSplitGuid(dataStore, editor, GlobalId)) throw new Error('A native member or storey Root identity is missing or ambiguous');
    return { expressId, GlobalId, Name: typeof record.attributes[2] === 'string' ? record.attributes[2] : null, type: record.type };
  };
  const members: Array<ZoneMembership & ReturnType<typeof identity>> = [];
  for (const [globalId, rows] of state.zoneAssignments) {
    const assignment = rows[zoneSetId]; if (!assignment?.touchedZoneIds.length) continue;
    const ref = state.resolveGlobalIdFromModels(globalId); if (!ref) throw new Error('An evaluated member no longer resolves to a loaded native model');
    if (ref.modelId !== modelId) continue;
    if (members.length >= 200 || assignment.touchedZoneIds.some(id => !set.zones.some(zone => zone.id === id))) throw new Error('The evaluated membership is incomplete or exceeds the review limit');
    members.push({ ...identity(ref.expressId), touchedZoneIds: [...assignment.touchedZoneIds] });
  }
  if (!members.length) throw new Error('No evaluated elements of the chosen model reach this zone set');
  const prior = view.prepareAtomic(draftView => {
    const draft = new StoreEditor(dataStore, draftView), before = draft.getNewEntities();
    const replaced = removeSpatialZones(draft, set), after = new Set(draft.getNewEntities().map(row => row.expressId));
    const removed = before.filter(row => !after.has(row.expressId));
    if (removed.length > 200) throw new Error('The marked prior-output graph exceeds the review limit');
    const ids = new Set(removed.map(row => row.expressId));
    for (const [id, refs] of effectiveCostReferenceOccurrences(dataStore, view, ids)) if ([...refs.keys()].some(ref => !ids.has(ref))) throw new Error(`Prior native zone record #${id} is referenced outside its owned output; replacement is unavailable`);
    return { replaced, removed: removed.map(row => ({ expressId: row.expressId, type: row.type, attributes: structuredClone(row.attributes) })) };
  }).result;
  // @raw-entity-enumeration-ok source SpatialZone bucket seeds imported-output candidates; the effective iterator applies current deletions/retypes before counting source-only outputs.
  const imported = [...iterateEffectiveEntities(dataStore, view, undefined, new Set(dataStore.entityIndex.byType.get('IFCSPATIALZONE') ?? []))].filter(row => row.type.toUpperCase() === 'IFCSPATIALZONE' && !view.getNewEntity(row.expressId)).length;
  const expected = { modelId, zoneSetId, evaluationId: currentZoneEvaluationIdentity(state, initializingModel), storey: identity(storeyId), set: structuredClone(set), members,
    frame: zoneEmissionFrameFor(model, resolveRenderFrame(state.models, state.geometryResult)),
    rebased: model.federationAlignmentStatus === 'same-crs' || model.federationAlignmentStatus === 'reprojected',
    schema: anchor.schema, lengthUnitScale: anchor.lengthUnitScale, prior, importedSourceZonesRetained: imported };
  if (expected.rebased) throw new Error('This model was rebased during federation alignment; native zone emission cannot recover its frame');
  if (JSON.stringify(expected).length > 70000) throw new Error('The complete native zone emission evidence exceeds the text limit');
  lease.validate(); return expected;
}
export function nativeZoneEmissionEvidence(state: ViewerState, modelId: string) {
  try {
    if (!zoneEvaluationIsCurrent(state)) return { status: 'unavailable-evaluation', count: null, choices: [] };
    const target = readOnlyModelEditLease(state, modelId)?.target; if (!target) throw new Error('Native model unavailable');
    // @raw-entity-enumeration-ok source storey candidates only; effective iteration includes native creations and applies tombstones/retypes.
    const storeys = [...iterateEffectiveEntities(target.dataStore, target.view, undefined, new Set(target.dataStore.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? []))].filter(row => row.type.toUpperCase() === 'IFCBUILDINGSTOREY');
    if (storeys.length > 10 || state.zoneSets.length > 10) throw new Error('Too many explicit zone-set/storey choices for complete evidence');
    const choices = state.zoneSets.flatMap(set => storeys.map(storey => {
      try { return { modelId, zoneSetId: set.id, storeyId: storey.expressId, status: 'available', expected: readZoneEmissionSnapshot(state, modelId, set.id, storey.expressId) }; }
      catch (error) { return { modelId, zoneSetId: set.id, storeyId: storey.expressId, status: 'unavailable', reason: error instanceof Error ? error.message : String(error), expected: null }; }
    }));
    if (JSON.stringify(choices).length > 70000) throw new Error('The complete target catalogue exceeds the native evidence text limit');
    return { status: 'available-targets', count: choices.length, choices };
  } catch (error) { console.warn('[Assistant] Native zone emission evidence unavailable', error); return { status: 'unavailable', count: null, choices: [] }; }
}
export function nativeZoneEmissionTransport(state: ViewerState, modelId: string) {
  const evidence = nativeZoneEmissionEvidence(state, modelId);
  return { status: evidence.status, count: evidence.count, choices: evidence.choices.map(choice => ({ ...choice, expected: undefined,
    expectedJsonParts: choice.expected ? JSON.stringify(choice.expected).match(/[\s\S]{1,1000}/g) : null })) };
}
