/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { ensureModelExportReady } from '@/services/desktop-export';
import { exportChangedModelToStep } from '@/lib/export/changed-model-export';
import { collectChangedModels } from '@/lib/export/model-changes';
import { mapStepSchema } from '@/lib/export/artifact-naming';
import { sanitizeFilename } from '@/lib/export/download';
import { RegistryError } from './protocol';

/** Export the active model through the same complete, mutation-aware path as Export modified IFC. */
export async function exportRegistryModel(): Promise<{ bytes: Uint8Array<ArrayBuffer>; filename: string }> {
  const state = useViewerStore.getState();
  const id = state.activeModelId ?? (state.models.size === 1 ? state.models.keys().next().value : undefined);
  if (!id) throw new RegistryError('Open and select an IFC model before publishing.');
  const model = state.models.get(id);
  if (!model || model.schemaVersion === 'IFC5') throw new RegistryError('Select an IFC STEP model for this demo.');
  const data = await ensureModelExportReady(id);
  if (!data) throw new RegistryError('The model is not ready to export.');
  const schedule = collectChangedModels(state).scheduleTargetModelId === id ? {
    scheduleData: state.scheduleData, scheduleIsEdited: state.scheduleIsEdited, scheduleSourceModelId: id,
  } : null;
  const result = await exportChangedModelToStep(id, data, state.mutationViews.get(id), {
    schema: mapStepSchema(model.schemaVersion),
    georefMutations: state.georefMutations.get(id),
    scheduleState: schedule,
    description: 'Model release published from IFClite',
  });
  const current = useViewerStore.getState();
  if (current.mutationVersion !== state.mutationVersion || current.models.get(id) !== model) {
    throw new RegistryError('The model changed while exporting. Please publish again.');
  }
  if (result.ext !== 'ifc' || result.skippedCount) throw new RegistryError('This demo publishes plain IFC files. This model needs a different export format.');
  let filename = sanitizeFilename(model.name, { fallback: 'model.ifc' });
  if (!filename.toLowerCase().endsWith('.ifc')) filename += '.ifc';
  return { bytes: typeof result.content === 'string' ? new TextEncoder().encode(result.content) : new Uint8Array(result.content), filename };
}
