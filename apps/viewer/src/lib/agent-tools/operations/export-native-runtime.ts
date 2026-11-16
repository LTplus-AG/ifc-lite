/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { isCaptureModel } from '@/lib/export/capture-export';
import type { FederatedModel } from '@/store/types';
import { exportCheckpoint } from './exports-common';
import type { ViewerOperationContext } from './contract';
type NativeExportTarget = Pick<FederatedModel, 'id' | 'name' | 'ifcDataStore' | 'geometryResult' | 'sourceFile' | 'schemaVersion' | 'idOffset' | 'maxExpressId'>;
export function nativeExportTarget(id: string): NativeExportTarget {
  const s = useViewerStore.getState();
  if (id === '__legacy__' && s.models.size === 0 && (s.ifcDataStore || s.geometryResult)) return {
    id, name: 'Current Model', ifcDataStore: s.ifcDataStore, geometryResult: s.geometryResult, schemaVersion: s.ifcDataStore?.schemaVersion ?? 'IFC4', sourceFile: undefined, idOffset: 0, maxExpressId: 0,
  };
  const model = s.models.get(id);
  if (!model || isCaptureModel(model)) throw new Error('Choose one existing exportable model; Gaussian captures are excluded by the native export registry.');
  return model;
}
export function nativeStepTarget(id: string) {
  const model = nativeExportTarget(id);
  if (!model.sourceFile || !/\.(ifc|ifczip)$/i.test(model.sourceFile.name)) throw new Error('Native USD/Rhino export requires a retained .ifc/.ifczip source.');
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
      || now.mergeLayers !== s.mergeLayers || now.georefMutations !== s.georefMutations) throw new Error('Native export visibility, geometry or georeference settings changed during production.');
  };
}
export async function nativeArtifact(c: ViewerOperationContext, blob: Blob, filename: string, diagnostics: unknown, check: () => void) {
  check(); const artifact = await c.artifacts.create({ filename, mimeType: blob.type, data: blob });
  return { artifact, diagnostics_json: JSON.stringify(diagnostics) };
}
export const targetSchema = { type: 'string' as const, minLength: 1, maxLength: 200 };
