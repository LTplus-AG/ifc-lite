/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Canonical renderer destination frame for every federation anchor. */

import type { ModelSpatialReference } from '@ifc-lite/geometry';
import type { ModelSpatialPlacement } from './federationAlign.js';

const RENDERER_SOURCE_FRAME = {
  axes: ['east', 'up', 'south'] as const,
  horizontalUnitToMetres: 1,
  verticalUnitToMetres: 1,
};

/**
 * Keep a source adapter's raw axes/units immutable, while making every
 * federation destination renderer E/U/S metres. Scan anchors are the case
 * that makes this distinction observable: LAS may be North/East/Up US-survey
 * feet, but the renderer (and every model baked toward it) is never that.
 */
export function canonicalRendererPlacement(
  placement: ModelSpatialPlacement,
): ModelSpatialPlacement {
  const spatialReference: ModelSpatialReference = {
    ...placement.spatialReference,
    source: RENDERER_SOURCE_FRAME,
  };
  return { ...placement, spatialReference };
}
