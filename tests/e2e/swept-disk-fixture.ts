/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path';

/** Small committed CI model; opt in to the real Revit Snowdon authoring-tool witness. */
export const sweptDiskFixture = process.env.REBAR_IFC ? {
  path: process.env.REBAR_IFC,
  expressId: 132347,
  label: 'Snowdon Revit bar',
  radiusText: '9.525 mm',
  totalLengthPrefix: '3.61642',
  segmentCount: 11,
  arcCount: 5,
} : {
  path: join(process.cwd(), 'rust/geometry/tests/fixtures/swept_disk_composite_arc_ubar.ifc'),
  expressId: 125,
  label: 'composite U-bar',
  radiusText: '1.45 cm',
  totalLengthPrefix: '1.13655',
  segmentCount: 5,
  arcCount: 2,
};

/**
 * The isolation witness needs geometry that isolation removes. The committed
 * U-bar is the only element in its file, so isolating it re-frames the same
 * pixels and no renderer can make that frame differ. This copy adds a concrete
 * stand-in block around the bar's bottom run; REBAR_IFC (Snowdon) already has
 * its own surrounding concrete.
 */
export const sweptDiskIsolationPath = process.env.REBAR_IFC
  ? sweptDiskFixture.path
  : join(process.cwd(), 'tests/e2e/fixtures/swept-disk-occluded-ubar.ifc');
