/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { GeometryProcessor } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { hasRetainedGeometryModel, RETAINED_EXACT_ONLY_REASON } from '@/store/retainedGeometry';
import { resolveStepExportBytes, type StepExportModel } from '@/components/viewer/step-export-source';
import { resolveRhinoVisibility, rhinoSceneOptions, type RhinoExportSettings } from '@/components/viewer/rhino-export-options';
import { exportRhino3dmInWorker, type RhinoExportProgress } from './rhino-export-client';
import { resolve as t } from '@/i18n/registry';
function gate(model: StepExportModel) {
  if (hasRetainedGeometryModel(useViewerStore.getState().models)) throw new Error(t(RETAINED_EXACT_ONLY_REASON));
  if (!/\.(ifc|ifczip)$/i.test(model.sourceFile.name)) throw new Error('This native exporter requires an IFC STEP source.');
}
export async function produceNativeUsd(model: StepExportModel, getMutationView = useViewerStore.getState().getMutationView, checkpoint = () => {}) {
  gate(model); checkpoint(); const bytes = await resolveStepExportBytes(model, getMutationView); checkpoint();
  const processor = new GeometryProcessor();
  try { await processor.init(); checkpoint(); const usd = processor.exportUsd(bytes); if (!usd) throw new Error(t('geometryExport.shared.geometryEngineUnavailableError')); checkpoint(); return new Blob([new Uint8Array(usd)], { type: 'text/plain' }); }
  finally { processor.dispose(); }
}
export async function produceNativeRhino(model: StepExportModel, settings: RhinoExportSettings, getMutationView = useViewerStore.getState().getMutationView, onProgress?: (p: RhinoExportProgress) => void, signal?: AbortSignal, checkpoint = () => {}) {
  gate(model); signal?.throwIfAborted(); checkpoint();
  const bytes = await resolveStepExportBytes(model, getMutationView); signal?.throwIfAborted(); checkpoint();
  const visibility = settings.visibleOnly ? resolveRhinoVisibility(useViewerStore.getState(), model.id) : undefined;
  const result = await exportRhino3dmInWorker({ content: bytes, options: rhinoSceneOptions(settings, visibility), version: settings.version }, onProgress, signal);
  checkpoint(); return result;
}
