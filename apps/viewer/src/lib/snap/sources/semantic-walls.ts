/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store glue for the semantic source: the wall axes of one storey, in
 * storey-local metres (the storey workplane's local frame).
 *
 * `extractWallSegmentsForStorey` is the canonical overlay-aware reader (axis
 * representation or rectangle profile, composed into the storey frame and
 * unit-scaled). Source and created walls both include pending edits.
 */

import { derivedState } from '@/lib/derived-state';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { extractWallSegmentsForStorey } from '@ifc-lite/create';
import type { WallAxis } from './semantic.js';

export function storeyWallAxes(
  store: IfcDataStore,
  view: MutablePropertyView,
  storeyId: number,
): WallAxis[] {
  return derivedState(store, view, `walls:${storeyId}`, [
    'IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE', 'IFCCURTAINWALL',
    'IFCVIRTUALELEMENT', 'IFCPLATE', 'IFCMEMBER', 'IFCRAILING',
    'IFCRELAGGREGATES', 'IFCRELCONTAINEDINSPATIALSTRUCTURE',
  ], tracked => {
    const res = extractWallSegmentsForStorey(store, storeyId, tracked);
    return res.segments.map((seg, i) => ({
      expressId: res.contributingWallIds[i], a: seg.a, b: seg.b,
    }));
  });
}
