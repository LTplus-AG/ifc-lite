/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Recompute registered scan transforms whenever the federation anchor changes. */

import type { ModelSpatialReference } from '@ifc-lite/geometry';
import {
  computePointCloudAlignment,
  realignRegisteredPointClouds,
  type PointCloudTransformTarget,
} from './pointCloudAlignment.js';
import type { ModelSpatialPlacement } from './federationAlign.js';

function sameDeclaredFrame(
  source: ModelSpatialReference | undefined,
  target: ModelSpatialReference,
): boolean {
  return source?.horizontal?.id === target.horizontal?.id
    && source?.vertical?.id === target.vertical?.id
    && source.horizontal !== undefined
    && source.vertical !== undefined;
}

/**
 * A scan that arrived before an anchor keeps its native GPU coordinates until
 * this function sees a matching, fully-declared CRS. Different or incomplete
 * declarations are actively restored to their native matrix, never guessed.
 */
export function realignPointCloudsToAnchor(
  renderer: PointCloudTransformTarget | null | undefined,
  anchor: ModelSpatialPlacement | null,
): void {
  realignRegisteredPointClouds(renderer, (source, sourceUnit) => (
    anchor && sameDeclaredFrame(source, anchor.spatialReference)
      ? computePointCloudAlignment(anchor, sourceUnit)
      : null
  ));
}
