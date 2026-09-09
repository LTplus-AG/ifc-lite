/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { generateIfcGuid } from '@ifc-lite/encoding';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { referenceFrameStatus } from './reference-runtime/frame';
import type { AppearanceCommitOptions } from './command';
import { prepareTexturedProduct } from './prepare-textured-product';
import { modelAppearanceAssets } from './model-assets';
import { createAppearancePlanner, type AppearancePlanner } from './planner-worker-client';
import { commitTexturedProduct } from './textured-product-command';
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
  const reference = useViewerStore.getState().appearanceReferences.get(referenceId);
  const validateReference = () => {
    const current = useViewerStore.getState();
    if (!reference || current.appearanceReferences.get(referenceId) !== reference || referenceFrameStatus(reference, current) !== 'ready') {
      throw new Error('Re-register the reference in the current coordinate frame.');
    }
  };
  validateReference();
  if (!reference) throw new Error('Choose a registered reference.');
  const target = await prepareTexturedProduct(modelId, options.signal, validateReference);
  const planner = options.planner ?? createAppearancePlanner();
  try {
    const frame = annotationFrame(reference);
    const translation = target.translation;
    frame.origin = [frame.origin[0] - translation[0], frame.origin[1] - translation[1], frame.origin[2] - translation[2]];
    const native = await planner.annotationPlan(target.bytes, { schema: target.schema, sourceRevision: target.sourceRevision, nextExpressId: target.nextExpressId,
      containerId, GlobalId: generateIfcGuid(), containmentGlobalId: generateIfcGuid(),
      Name: options.Name?.trim() || 'Image reference', imageUri: modelAppearanceAssets.getAuthoredUri(modelId, reference.assetId),
      frame }, { signal: options.signal });
    target.validate();
    return await commitTexturedProduct(modelId, reference.assetId, { ...native, objectId: native.annotationId }, containerId, renderer, target.source, options);
  } finally { if (!options.planner) planner.dispose(); }
}
