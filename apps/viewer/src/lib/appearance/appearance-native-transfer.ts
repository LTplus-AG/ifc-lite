/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expandAppearanceCorners, type Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { ScanValidationError } from '@/components/viewer/appearance/scan-validation-message';
import { AppearancePreviewSession, bindAppearancePreview } from './preview';
import type { prepareMeshTransfer } from './scan/prepare-transfer';
/** One binding/staging path for the native Scan Transfer panel and operations. */
export function stageNativeScanTransfer(
  output: Awaited<ReturnType<typeof prepareMeshTransfer>>,
  targetModelId: string,
  renderer: Renderer,
) {
  if (!output.plan) throw new Error('The native transfer produced no applicable appearance plan.');
  const first = output.itemImages.values().next().value;
  if (!first) throw new ScanValidationError('appearance.scanTransfer.error.noRetainedImage');
  const groups = bindAppearancePreview(
    useViewerStore.getState(),
    renderer,
    targetModelId,
    output.plan,
    first.bitmap,
    first.imageUri,
    false,
    false,
    expandAppearanceCorners,
    output.itemImages,
  );
  const preview = new AppearancePreviewSession(renderer);
  try {
    preview.stage(groups);
    return { groups, preview };
  } catch (error) {
    preview.cancel();
    throw error;
  }
}
