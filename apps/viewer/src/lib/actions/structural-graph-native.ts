/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createStructuralStoreBackend, resolveLiveOwnerHistoryId } from '@ifc-lite/sdk';
import { liveEntityConforms } from '@ifc-lite/create';
import { effectiveMetadataRecord, getAttributeTypeForSchema, getSchemaRegistryForVersion } from '@ifc-lite/parser';
import { isValidIfcGuid } from '@ifc-lite/encoding';
import { MutablePropertyView, type StoreEditor } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { structuralClosure, type StructuralSnapshot } from './structural-graph-evidence';
import { structuralRef, type StructuralProposal, type StructuralRef } from './structural-graph-proposal';
import { uniqueSplitGuid } from './model-authoring-split';
import { nativeLengthUnitAvailable } from './model-authoring-read-target';
export interface StructuralWriteRow { index: number; expressId: number }
const types = { 'structural.analysis.create': 'IfcStructuralAnalysisModel', 'structural.member.create': 'IfcStructuralCurveMember', 'structural.connection.create': 'IfcStructuralPointConnection', 'structural.group.create': 'IfcStructuralLoadGroup', 'structural.pointAction.create': 'IfcStructuralPointAction', 'structural.linearAction.create': 'IfcStructuralLinearAction' } as const;
export function writeStructuralOperations(_state: Pick<ViewerState, 'models' | 'mutationViews'>, target: ModelEditTarget, draft: StoreEditor,
  proposal: StructuralProposal, snapshot: StructuralSnapshot, approved: ReadonlySet<number>): StructuralWriteRow[] {
  const { modelId, dataStore } = target, view = draft.getMutationView(), refs = new Map<string, number>(), captured = new Set(snapshot.records.map(row => row.expressId));
  const write = createStructuralStoreBackend(() => ({ modelId, store: dataStore, editor: draft, mutationView: view, ownerHistoryId: resolveLiveOwnerHistoryId(dataStore, draft, view) }));
  const resolve = (ref: StructuralRef, expected?: string) => {
    const id = typeof ref === 'number' ? ref : refs.get(ref.ref);
    if (id === undefined || typeof ref === 'number' && !captured.has(id) || view.isDeleted(id)) throw new Error('Approve the earlier creation or attach the complete native reference');
    if (expected && !liveEntityConforms(dataStore, id, expected, view)) throw new Error(`Native reference #${id} must be ${expected}`);
    if (liveEntityConforms(dataStore, id, 'IfcRoot', view)) {
      const guid = effectiveMetadataRecord(dataStore, id, view)?.attributes[0];
      if (typeof guid !== 'string' || !isValidIfcGuid(guid) || !uniqueSplitGuid(dataStore, draft, guid)) throw new Error('Native Structural Root identity is invalid or ambiguous');
    }
    return id;
  };
  const storey = (ref: StructuralRef) => {
    const id = resolve(ref, 'IfcBuildingStorey');
    if (!nativeLengthUnitAvailable({ ...target, editor: draft, view })) throw new Error('The source geometry length unit is unavailable');
    const sourceView = new MutablePropertyView(dataStore.properties ?? null, modelId), sourceTarget = { ...target, view: sourceView };
    for (const record of snapshot.records) if (['IfcProject', 'IfcUnitAssignment'].includes(record.type) || liveEntityConforms(dataStore, record.expressId, 'IfcUnit', view)) {
      if (JSON.stringify(effectiveMetadataRecord(dataStore, record.expressId, sourceView)) !== JSON.stringify(effectiveMetadataRecord(dataStore, record.expressId, view))) throw new Error('The native source geometry unit declaration changed');
    }
    const source = effectiveMetadataRecord(dataStore, id, sourceView), current = effectiveMetadataRecord(dataStore, id, view);
    if (!source || JSON.stringify(source.attributes[5]) !== JSON.stringify(current?.attributes[5])) throw new Error('The native Structural builder requires an unchanged source storey placement');
    for (const dependency of structuralClosure(sourceTarget, new Set([id]))) if (dependency !== id
      && JSON.stringify(effectiveMetadataRecord(dataStore, dependency, sourceView)) !== JSON.stringify(effectiveMetadataRecord(dataStore, dependency, view))) throw new Error('The native source storey frame changed; this Structural route cannot verify it');
    return id;
  };
  return proposal.operations.flatMap((operation, index): StructuralWriteRow[] => {
    if (!approved.has(index)) return [];
    const params = { ...operation.params };
    for (const key of ['LoadGroupIds', 'ResultGroupIds']) if (Array.isArray(params[key])) params[key] = params[key].map(ref => resolve(structuralRef(ref), key === 'LoadGroupIds' ? 'IfcStructuralLoadGroup' : 'IfcStructuralResultGroup'));
    if (operation.op in types) {
      const type = types[operation.op as keyof typeof types], schema = dataStore.schemaVersion;
      if (schema !== 'IFC4' && schema !== 'IFC4X3') throw new Error('Supply a supported declared IFC4/IFC4X3 schema');
      const registry = getSchemaRegistryForVersion(schema);
      for (const [key, value] of Object.entries(params)) { const attrType = getAttributeTypeForSchema(type, key, schema), values = attrType ? registry.enums[attrType] : undefined; if (values && (typeof value !== 'string' || !values.includes(value))) throw new Error(`${key} is not a native IFC enumeration value`); }
    }
    let id: number;
    // JSON is bounded/typed; canonical native factories remain the sole serializers and geometry/relationship owners.
    switch (operation.op) {
      case 'structural.analysis.create': id = write.addStructuralAnalysisModel(modelId, params).expressId; break;
      case 'structural.member.create': id = write.addStructuralCurveMember(modelId, storey(operation.storey!), params as unknown as Parameters<typeof write.addStructuralCurveMember>[2]).expressId; break;
      case 'structural.connection.create': id = write.addStructuralPointConnection(modelId, storey(operation.storey!), params as unknown as Parameters<typeof write.addStructuralPointConnection>[2]).expressId; break;
      case 'structural.group.create': id = write.addStructuralLoadGroup(modelId, params as unknown as Parameters<typeof write.addStructuralLoadGroup>[1]).expressId; break;
      case 'structural.pointAction.create': id = write.addStructuralPointAction(modelId, params).expressId; break;
      case 'structural.linearAction.create': id = write.addStructuralLinearAction(modelId, params).expressId; break;
      case 'structural.member.connect': id = write.connectStructuralMemberToConnection(modelId, resolve(operation.target!, 'IfcStructuralMember'), resolve(operation.related![0], 'IfcStructuralConnection')).expressId; break;
      case 'structural.activity.connect': id = write.connectStructuralActivityToItem(modelId, resolve(operation.target!, 'IfcStructuralActivityAssignmentSelect'), resolve(operation.related![0], 'IfcStructuralActivity')).expressId; break;
      case 'structural.group.assign': { const group = resolve(operation.target!, 'IfcGroup'), objects = operation.related!.map(ref => resolve(ref, 'IfcObjectDefinition')); if (objects.includes(group)) throw new Error('A group cannot assign itself'); id = write.assignToStructuralGroup(modelId, group, objects).expressId; break; }
    }
    captured.add(id); resolve(id, 'IfcRoot');
    if (operation.ref) refs.set(operation.ref, id);
    return [{ index, expressId: id }];
  });
}
