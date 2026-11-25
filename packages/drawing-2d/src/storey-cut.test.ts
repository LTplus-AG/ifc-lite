/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { storeyCutElevation } from './index.js';

// rvt01.ifc (Revit): IfcSite at Z 14.23, storey "GR_GROUND FLOOR FFL" Elevation 0.5,
// meshes re-based by a wasm RTC offset of Z 14.73, so that floor sits at render Y 0.
const revitFrame = { wasmRtcOffset: { x: 500373.11, y: 2780223.98, z: 14.73 }, siteOrigin: { x: 500373.11, y: 2780223.98, z: 14.23 } };

describe('storey-relative plan cut in the render frame (#10931)', () => {
  it('cuts 1.2 m above the storey floor of a re-based model', () => {
    expect(storeyCutElevation(0.5, 1.2, revitFrame)).toBeCloseTo(1.2, 9);
  });

  it('adds the building placement Z, since IfcBuildingStorey.Elevation is relative to the building', () => {
    expect(storeyCutElevation(0, 1.2, { siteOrigin: { x: 0, y: 0, z: 0 }, buildingOrigin: { z: 3 } })).toBeCloseTo(4.2, 9);
    expect(storeyCutElevation(0.5, 1.2, { ...revitFrame, wasmRtcOffset: { ...revitFrame.wasmRtcOffset, z: 17.73 }, buildingOrigin: { z: 3 } })).toBeCloseTo(1.2, 9);
  });

  it('takes the JS origin shift off as well', () => {
    expect(storeyCutElevation(3, 1.2, { originShift: { x: 0, y: 2, z: 0 } })).toBeCloseTo(2.2, 9);
    expect(storeyCutElevation(3)).toBeCloseTo(4.2, 9);
  });
});
