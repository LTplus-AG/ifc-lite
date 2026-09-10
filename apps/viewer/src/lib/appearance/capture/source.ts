/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { modelAppearanceAssets } from '../model-assets';
import type { CapturedMeshSource } from '../create-captured-mesh';
import { captureRegistration, captureRegion } from './region';

/** Bind region, registration and the original encoded image as one source.
 * The creation command retains this asset before its first asynchronous step. */
export function prepareCapturedRegion(modelId: string, rawMesh: MeshData,
  triangleOrdinals: readonly number[]): CapturedMeshSource {
  const registration = captureRegistration(modelId, rawMesh);
  const region = captureRegion(rawMesh, triangleOrdinals, registration);
  const assetId = modelAppearanceAssets.resolveImageAsset(modelId, region.textureRef.url);
  return { assetId, mesh: region.mesh, repeatS: region.textureRef.repeatS, repeatT: region.textureRef.repeatT,
    validate() {
      registration.validate();
      if (modelAppearanceAssets.resolveImageAsset(modelId, region.textureRef.url) !== assetId) {
        throw new Error('The captured image changed. Choose the region again.');
      }
    } };
}
