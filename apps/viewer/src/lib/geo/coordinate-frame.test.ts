/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ifcToViewerAxes, totalYupOffset, viewerToIfcAxes } from './coordinate-frame.js';

/**
 * #4799 caller audit: federationAlign, ifc-origin, geometrySummary and scan
 * sections still add the converted RTC to originShift; when shift.z is -0 and
 * rtc.y is +0 their result intentionally normalises from -0 to +0. Cesium
 * bridge, footprint reprojection and
 * drawing profiles keep their original three-term / RTC-or-shift ordering;
 * their converted negative axis now follows this module's positive-zero rule.
 * Measure coordinates already used that rule. Cesium placement, KMZ altitude,
 * symbolic elevation and DXF elevation read the non-negated vertical component,
 * so their signs and arithmetic are unchanged. Map-center's inverse negation
 * has the same intentional -0 to +0 rule, pinned in map-absolute.test.ts.
 */
describe('coordinate frame', () => {
  it('maps IFC Z-up and viewer Y-up in both directions', () => {
    assert.deepEqual(ifcToViewerAxes({ x: 2, y: 3, z: 5 }), { x: 2, y: 5, z: -3 });
    assert.deepEqual(viewerToIfcAxes({ x: 2, y: 5, z: -3 }), { x: 2, y: 3, z: 5 });
    assert.deepEqual(
      viewerToIfcAxes(ifcToViewerAxes({ x: -7.5, y: 11.25, z: -4 })),
      { x: -7.5, y: 11.25, z: -4 },
    );
  });

  it('does not turn non-finite coordinates into zero', () => {
    const viewer = ifcToViewerAxes({ x: Number.NaN, y: Number.NaN, z: Number.NaN });
    assert.equal(Number.isNaN(viewer.x), true);
    assert.equal(Number.isNaN(viewer.y), true);
    assert.equal(Number.isNaN(viewer.z), true);
  });

  it('normalises both input signs of zero only on each negated axis (#4799)', () => {
    for (const zero of [0, -0]) {
      const fromIfc = ifcToViewerAxes({ x: -0, y: zero, z: -0 });
      assert.equal(Object.is(fromIfc.x, -0), true);
      assert.equal(Object.is(fromIfc.y, -0), true);
      assert.equal(Object.is(fromIfc.z, -0), false);

      const fromViewer = viewerToIfcAxes({ x: -0, y: -0, z: zero });
      assert.equal(Object.is(fromViewer.x, -0), true);
      assert.equal(Object.is(fromViewer.y, -0), false);
      assert.equal(Object.is(fromViewer.z, -0), true);
    }
  });

  it('composes the Y-up origin shift with the converted IFC RTC offset', () => {
    assert.deepEqual(
      totalYupOffset({
        originShift: { x: 10, y: 20, z: 30 },
        wasmRtcOffset: { x: 100, y: 200, z: 300 },
      }),
      { x: 110, y: 320, z: -170 },
    );
    assert.deepEqual(totalYupOffset(undefined), { x: 0, y: 0, z: 0 });
  });

  it('composes absent and present signed-zero offsets without normalising unrelated axes (#4799)', () => {
    const absent = totalYupOffset(undefined);
    assert.equal(Object.is(absent.x, -0), false);
    assert.equal(Object.is(absent.y, -0), false);
    assert.equal(Object.is(absent.z, -0), false);

    for (const rtcY of [0, -0]) {
      const present = totalYupOffset({
        originShift: { x: -0, y: -0, z: -0 },
        wasmRtcOffset: { x: -0, y: rtcY, z: -0 },
      });
      assert.equal(Object.is(present.x, -0), true);
      assert.equal(Object.is(present.y, -0), true);
      assert.equal(Object.is(present.z, -0), false);
      assert.equal(Object.is(present.z, 0), true);
    }
  });
});
