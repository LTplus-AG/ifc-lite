// SPDX-License-Identifier: MPL-2.0
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { federationFrameInfo } from '@ifc-lite/geometry/world-frame';
import { isStreamedScanOnly } from '@ifc-lite/geometry/rtc-rebase';
import type { FederatedModel } from '@/store/types';

/** Captures and streamed scans never define the scene's IFC frame. */
export function frameCandidateModels(models: Iterable<FederatedModel>): FederatedModel[] {
  return [...models].filter(model => !model.gaussianSplat
    // A streamed scan carries synthetic zero coordinateInfo for its GPU asset.
    // A model of inline clouds carries a real frame, which the RTC re-base
    // moves like any other (#10029), so it is a candidate (#10094).
    && !(model.geometryResult?.pointClouds?.length && isStreamedScanOnly(model.geometryResult)));
}

/** One frame for IFC geometry, point clouds, scene tools, and capture placement. */
export function sharedRenderFrame(
  models: Iterable<FederatedModel>,
  geometryResult?: { coordinateInfo?: CoordinateInfo | null } | null,
): CoordinateInfo | null {
  return federationFrameInfo(frameCandidateModels(models), geometryResult);
}
