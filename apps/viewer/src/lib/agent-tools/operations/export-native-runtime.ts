/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { isCaptureModel } from '@/lib/export/capture-export';
import type { FederatedModel } from '@/store/types';
import { exportCheckpoint } from './exports-common';
import { compositionOwners } from '../main-viewer-host';
import type { ViewerOperationContext } from './contract';
import { invalidInput, stale, unavailable } from './refusals';
type NativeExportTarget = Pick<FederatedModel, 'id' | 'name' | 'ifcDataStore' | 'geometryResult' | 'sourceFile' | 'schemaVersion' | 'idOffset' | 'maxExpressId'>;
export function nativeExportTarget(id: string): NativeExportTarget {
  const s = useViewerStore.getState();
  if (id === '__legacy__' && s.models.size === 0 && (s.ifcDataStore || s.geometryResult)) return {
    id, name: 'Current Model', ifcDataStore: s.ifcDataStore, geometryResult: s.geometryResult, schemaVersion: s.ifcDataStore?.schemaVersion ?? 'IFC4', sourceFile: undefined, idOffset: 0, maxExpressId: 0,
  };
  const model = s.models.get(id);
  if (!model || isCaptureModel(model)) throw invalidInput('unknown-target', 'Choose one existing exportable model; Gaussian captures are excluded by the native export registry.');
  refuseComposedLayer(id);
  return model;
}
/**
 * A composed IFCX layer shares its composition's store: exporting it would write the whole composition under the
 * layer's id, without the edits keyed to the owner (#10695).
 */
export function refuseComposedLayer(id: string, modelIds?: readonly string[]): void {
  const s = useViewerStore.getState(), owner = compositionOwners([...s.models], s).get(id);
  if (!owner) return;
  const fix = !modelIds ? `Pass target_model_id '${owner}' instead.`
    : modelIds.includes(owner) ? `Drop '${id}' from model_ids; '${owner}' already covers it.` : `List '${owner}' in model_ids in its place.`;
  throw invalidInput('wrong-target', `Model '${s.models.get(id)?.name ?? id}' is one layer of a composed model. ${fix}`);
}
export function nativeStepTarget(id: string) {
  const model = nativeExportTarget(id);
  if (!model.sourceFile || !/\.(ifc|ifczip)$/i.test(model.sourceFile.name)) throw unavailable('This native export requires a retained .ifc/.ifczip source.');
  return { ...model, sourceFile: model.sourceFile };
}
/** Extend the common source guard with the current-view inputs these formats consume. */
export function nativeExportGuard(c: ViewerOperationContext, modelIds: readonly string[]) {
  const check = exportCheckpoint(c, modelIds); const s = useViewerStore.getState();
  return () => {
    c.signal?.throwIfAborted(); check(); const now = useViewerStore.getState();
    if (now.models.size !== s.models.size || now.collabRoomId !== s.collabRoomId
      || now.sectionPlane !== s.sectionPlane || now.inactiveSectionPlanes !== s.inactiveSectionPlanes
      || now.hiddenEntities !== s.hiddenEntities || now.isolatedEntities !== s.isolatedEntities
      || now.ghostExceptEntities !== s.ghostExceptEntities || now.lensHiddenIds !== s.lensHiddenIds
      || now.classFilter !== s.classFilter || now.selectedStoreys !== s.selectedStoreys
      || now.typeVisibility !== s.typeVisibility || now.structuralViewMode !== s.structuralViewMode
      || now.mergeLayers !== s.mergeLayers || now.georefMutations !== s.georefMutations) throw stale('Native export visibility, geometry or georeference settings changed during production.');
  };
}
/** A visible-only export also reads the current view, so it is discarded when the view changes (#10695). */
export const exportGuard = (c: ViewerOperationContext, ids: readonly string[], visibleOnly: boolean) =>
  visibleOnly ? nativeExportGuard(c, ids) : exportCheckpoint(c, ids);
export async function nativeArtifact(c: ViewerOperationContext, blob: Blob, filename: string, diagnostics: unknown, check: () => void) {
  check(); const artifact = await c.artifacts.create({ filename, mimeType: blob.type, data: blob });
  return { artifact, diagnostics_json: JSON.stringify(diagnostics) };
}
export const targetSchema = { type: 'string' as const, minLength: 1, maxLength: 200 };
