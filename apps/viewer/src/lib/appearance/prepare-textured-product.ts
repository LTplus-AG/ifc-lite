/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { StepExporter } from '@ifc-lite/export';
import { StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { placementFor } from '@/lib/model-placement/state';
import { appearanceRevision, captureAppearanceSource } from './command';
import { prepareAppearanceSerialization } from './serialization';

/** One effective IFC snapshot and allocation guard for every textured product. */
export async function prepareTexturedProduct(modelId: string, signal?: AbortSignal, validateSource: () => void = () => {}) {
  const state = useViewerStore.getState(), model = state.models.get(modelId), view = state.mutationViews.get(modelId);
  if (!model?.ifcDataStore || !view || !model.schemaVersion.startsWith('IFC4')) throw new Error('Choose an editable IFC4 or IFC4X3 model.');
  if (state.modelPlacement.preview) throw new Error('Finish repositioning the model before creating an object.');
  if (model.federationAlignmentStatus === 'same-crs' || model.federationAlignmentStatus === 'reprojected') {
    throw new Error('Creating an object in a realigned model requires its source coordinate transform. Choose the workspace anchor model.');
  }
  if (state.collabRoomId) throw new Error('Leave the shared room before creating objects, then share the finished model.');
  if (model.ifcDataStore.source.byteLength > 128 * 1024 * 1024) throw new Error('This model exceeds the 128 MiB object preparation budget.');
  new StoreEditor(model.ifcDataStore, view);
  const source = captureAppearanceSource(view), sourceRevision = appearanceRevision(modelId);
  const nextExpressId = view.peekNextExpressId();
  const schema = model.schemaVersion.startsWith('IFC4X3') ? 'IFC4X3' as const : 'IFC4' as const;
  const validate = () => {
    if (signal?.aborted) throw new DOMException('Object creation cancelled.', 'AbortError');
    const current = useViewerStore.getState();
    if (current.modelPlacement !== state.modelPlacement || current.models.get(modelId) !== model
      || current.collabRoomId || appearanceRevision(modelId) !== sourceRevision) throw new Error('The target model changed. Try again.');
    source.validate(current.mutationViews.get(modelId));
    validateSource();
  };
  validate();
  const serialized = prepareAppearanceSerialization(modelId, model.ifcDataStore, view);
  const exported = await new StepExporter(model.ifcDataStore, serialized.view).exportAsync({
    schema, applyMutations: true, includeGeometry: true, visibleOnly: false, onProgress: validate,
  });
  validate();
  const bytes = typeof exported.content === 'string' ? new TextEncoder().encode(exported.content) : exported.content;
  return { bytes, schema, sourceRevision, nextExpressId, validate,
    translation: placementFor(state.modelPlacement, modelId).translation,
    source: { validate(current: Parameters<typeof source.validate>[0]) { validate(); source.validate(current); } } };
}
