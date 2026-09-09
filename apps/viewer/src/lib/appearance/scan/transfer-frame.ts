/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import { totalYupOffset } from '@/hooks/ingest/federationAlign';
import { placementFrameCoordinateInfo } from '@/lib/model-placement/persistence';
import { placementFor } from '@/lib/model-placement/state';
import { fromRenderTranslation } from '@/lib/model-placement/translation';
import type { TransferFrame } from './transfer-types';

/** Native IFC world -> the exact restored frame used by targetLandmark.
 * Raw loaded coordinates have the model's current RTC/rebase removed; picking
 * restores the workspace offset, then committed placement. CRS rebakes need a
 * separately retained source transform and are deliberately not guessed here. */
export function targetTransferFrame(state: ViewerState, modelId: string): TransferFrame {
  const model = state.models.get(modelId);
  if (!model?.geometryResult || state.modelPlacement.preview) throw new Error('Finish loading and repositioning before transferring appearance.');
  if (model.federationAlignmentStatus === 'same-crs' || model.federationAlignmentStatus === 'reprojected') throw new Error('Transfer to a CRS-realigned model needs its original source transform. Choose an un-realigned IFC target.');
  const source = totalYupOffset(model.geometryResult.coordinateInfo), target = totalYupOffset(placementFrameCoordinateInfo(state));
  const offset = fromRenderTranslation({ x: target.x - source.x, y: target.y - source.y, z: target.z - source.z });
  const placement = placementFor(state.modelPlacement, modelId).translation;
  return { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], sourceAnchor: [0, 0, 0],
    targetAnchor: [offset[0] + placement[0], offset[1] + placement[1], offset[2] + placement[2]] };
}
