/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { StepExporter } from '@ifc-lite/export';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { StoreEditor } from '@ifc-lite/mutations';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { placementFor } from '@/lib/model-placement/state';
import { referenceFrameStatus } from './reference-runtime/frame';
import { appearanceRevision, captureAppearanceSource, type AppearanceCommitOptions } from './command';
import { modelAppearanceAssets } from './model-assets';
import { prepareAppearanceSerialization } from './serialization';
import { createAppearancePlanner, type AppearancePlanner } from './planner-worker-client';
import { commitAnnotationPlane } from './annotation-command';
import type { AnnotationPlaneFrame } from './planner-types';
import type { RegisteredAppearanceReference } from './references/types';

export function annotationFrame(reference: Pick<RegisteredAppearanceReference, 'cornersIfcWorld'>): AnnotationPlaneFrame {
  const [tl, tr, br, bl] = reference.cornersIfcWorld;
  const u: [number, number, number] = [br[0] - bl[0], br[1] - bl[1], br[2] - bl[2]];
  const v: [number, number, number] = [tl[0] - bl[0], tl[1] - bl[1], tl[2] - bl[2]];
  const w = Math.hypot(...u), h = Math.hypot(...v);
  if (!(w > 0 && h > 0) || !Number.isFinite(w + h)) throw new Error('The reference has no finite plane size.');
  const tolerance = Math.max(w, h) * 1e-8;
  if (tr.some((value, axis) => Math.abs(value - (bl[axis] + u[axis] + v[axis])) > tolerance)) {
    throw new Error('Saving a reference requires a rectangular plane. Re-register its corners.');
  }
  return { origin: [...bl], axisU: [u[0] / w, u[1] / w, u[2] / w],
    axisV: [v[0] / h, v[1] / h, v[2] / h], sizeMetres: [w, h] };
}

/** The dock chooses a model and container; this command owns IFC snapshot/allocation. */
export async function createAnnotationFromReference(modelId: string, containerId: number, referenceId: string,
  renderer: Renderer, options: AppearanceCommitOptions & { Name?: string; planner?: AppearancePlanner } = {}) {
  const state = useViewerStore.getState(), model = state.models.get(modelId), view = state.mutationViews.get(modelId);
  const reference = state.appearanceReferences.get(referenceId);
  if (!reference || referenceFrameStatus(reference, state) !== 'ready') throw new Error('Re-register the reference in the current coordinate frame.');
  if (!model?.ifcDataStore || !view || !model.schemaVersion.startsWith('IFC4')) throw new Error('Choose an editable IFC4 or IFC4X3 model.');
  if (state.modelPlacement.preview) throw new Error('Finish repositioning the model before saving a reference.');
  if (model.federationAlignmentStatus === 'same-crs' || model.federationAlignmentStatus === 'reprojected') {
    throw new Error('Saving a reference into a realigned model requires its source coordinate transform. Choose the workspace anchor model.');
  }
  if (state.collabRoomId) throw new Error('Leave the shared room before creating annotations, then share the finished model.');
  if (model.ifcDataStore.source.byteLength > 128 * 1024 * 1024) throw new Error('This model exceeds the 128 MiB annotation preparation budget.');
  new StoreEditor(model.ifcDataStore, view);
  const source = captureAppearanceSource(view), sourceRevision = appearanceRevision(modelId);
  const nextExpressId = view.peekNextExpressId();
  const schema = model.schemaVersion.startsWith('IFC4X3') ? 'IFC4X3' as const : 'IFC4' as const;
  const validate = () => {
    if (options.signal?.aborted) throw new DOMException('Annotation creation cancelled.', 'AbortError');
    const current = useViewerStore.getState();
    if (current.modelPlacement !== state.modelPlacement || current.appearanceReferences.get(referenceId) !== reference || current.models.get(modelId) !== model
      || referenceFrameStatus(reference, current) !== 'ready' || appearanceRevision(modelId) !== sourceRevision) {
      throw new Error('The reference or target model changed. Try again.');
    }
    source.validate(current.mutationViews.get(modelId));
  };
  const planner = options.planner ?? createAppearancePlanner();
  try {
    validate();
    const serialized = prepareAppearanceSerialization(modelId, model.ifcDataStore, view);
    const exported = await new StepExporter(model.ifcDataStore, serialized.view).exportAsync({
      schema, applyMutations: true, includeGeometry: true, visibleOnly: false, onProgress: validate,
    });
    validate();
    const bytes = typeof exported.content === 'string' ? new TextEncoder().encode(exported.content) : exported.content;
    const frame = annotationFrame(reference);
    const translation = placementFor(state.modelPlacement, modelId).translation;
    frame.origin = [frame.origin[0] - translation[0], frame.origin[1] - translation[1], frame.origin[2] - translation[2]];
    const native = await planner.annotationPlan(bytes, { schema, sourceRevision, nextExpressId,
      containerId, GlobalId: generateIfcGuid(), containmentGlobalId: generateIfcGuid(),
      Name: options.Name?.trim() || 'Image reference', imageUri: modelAppearanceAssets.getAuthoredUri(modelId, reference.assetId),
      frame }, { signal: options.signal });
    validate();
    return await commitAnnotationPlane(modelId, reference.assetId, native, containerId, renderer, { validate(current) { validate(); source.validate(current); } }, options);
  } finally { if (!options.planner) planner.dispose(); }
}
