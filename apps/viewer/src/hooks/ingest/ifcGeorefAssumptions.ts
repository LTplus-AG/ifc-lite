/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ModelSpatialReference } from '@ifc-lite/geometry';
import type { UnknownVerticalPolicy } from './federationSpatialTransform.js';

/** A choice for IFC loads only; never extends a LandXML/scan's own policy. */
export function ifcUnknownVerticalPolicy(
  source: ModelSpatialReference, enabled: boolean,
): UnknownVerticalPolicy {
  return enabled && source.sourceMetadata?.format === 'ifc' ? 'assume-compatible' : 'refuse';
}

/** Record reliance, not just permission. A known mismatch still fails upstream. */
export function ifcSharedVerticalDatumApplied(
  source: ModelSpatialReference, target: ModelSpatialReference,
  status: string | undefined, enabled: boolean,
): true | undefined {
  const aligned = status === 'identity' || status === 'same-crs' || status === 'reprojected';
  return aligned && ifcUnknownVerticalPolicy(source, enabled) === 'assume-compatible'
    && (!source.vertical || !target.vertical) ? true : undefined;
}
