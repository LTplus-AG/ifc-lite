/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { totalYupOffset } from '@ifc-lite/geometry/world-frame';
import type { ViewerState } from '@/store';
import { sharedRenderFrame } from '@/lib/render-frame/sharedRenderFrame';
import { placementFor } from '@/lib/model-placement/state';
import { pointCloudExportFrame } from '@/hooks/ingest/pointCloudAlignmentRegistry';
import { gaussianCaptureFrame, gaussianUploadPlacement } from '@/hooks/ingest/gaussianCaptureFrame';

/** Inverse viewer axis conversion on every column, then project Z-up movement. */
function projectMatrix(matrix: readonly number[], translation: readonly number[]): number[] {
  const result = [...matrix];
  for (let col = 0; col < 4; col++) {
    result[col * 4 + 1] = -matrix[col * 4 + 2];
    result[col * 4 + 2] = matrix[col * 4 + 1];
  }
  for (let axis = 0; axis < 3; axis++) result[12 + axis] += translation[axis];
  return result;
}

/** An idle preview remains open after Apply in the placement tool. */
export function hasUnappliedPositionedMove(state: ViewerState, modelId: string): boolean {
  const preview = state.modelPlacement.preview;
  return Boolean(preview?.before.has(modelId) && preview.delta.some(value => value !== 0));
}

/** Capture once when the download starts: later UI edits cannot mix frames. */
export function positionedExportSnapshot(state: ViewerState, modelId: string) {
  const model = state.models.get(modelId);
  if (!model || !model.sourceFile) throw new Error('Original source unavailable. Reload the file before exporting.');
  if (model.loadState && model.loadState !== 'complete') throw new Error('Wait for the model to finish loading before exporting.');
  if (hasUnappliedPositionedMove(state, modelId)) throw new Error('Apply or cancel the placement preview before exporting.');
  if (placementFor(state.modelPlacement, modelId).rotation.angle) throw new Error('Scan and capture model rotation is not supported.');
  const translation = placementFor(state.modelPlacement, modelId).translation;
  if (model.gaussianSplat) {
    const capture = model.gaussianSplat;
    // Rebuild the canonical source placement without a temporary render offset.
    if (!capture.sourcePlacement && capture.placementOrigin === 'explicit') throw new Error('Reload this older capture before exporting its explicit placement.');
    const frame = gaussianCaptureFrame(capture.sourcePlacement, capture.upAxis);
    return { file: model.sourceFile, name: model.name, kind: 'gaussian' as const,
      matrix: projectMatrix(frame.placement, translation) };
  }
  if (model.pointCloudHandleId === undefined) throw new Error('Choose a scan or Gaussian capture.');
  const { matrix, origin } = pointCloudExportFrame(model.pointCloudHandleId);
  const offset = totalYupOffset(sharedRenderFrame(state.models.values(), state.geometryResult));
  matrix[12] += offset.x; matrix[13] += offset.y; matrix[14] += offset.z;
  // Decode emits Z-up locals; the scan renderer receives (x,z,-y).
  const native = [...matrix];
  for (let row = 0; row < 4; row++) { native[4 + row] = -matrix[8 + row]; native[8 + row] = matrix[4 + row]; }
  return { file: model.sourceFile, name: model.name, kind: 'scan' as const, origin,
    matrix: projectMatrix(native, translation) };
}

/** Gaussian decoder removes a source-space centre before narrowing to f32. */
export const restoreGaussianOrigin = gaussianUploadPlacement;
