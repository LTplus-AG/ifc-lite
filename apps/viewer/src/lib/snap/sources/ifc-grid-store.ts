/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store glue for the design-grid source: the axes of the IfcGrids that apply
 * to one storey, in storey-local metres (the storey workplane's local frame).
 * `extractGridAxesForStorey` is the canonical overlay-aware reader, so grids
 * from the file and grids authored this session both count.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { extractGridAxesForStorey, type GridAxisSegment } from '@ifc-lite/create';

export function storeyGridAxes(store: IfcDataStore, view: MutablePropertyView, storeyId: number): GridAxisSegment[] {
  return extractGridAxesForStorey(store, storeyId, view).axes;
}
