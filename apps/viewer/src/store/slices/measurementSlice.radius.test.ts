/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store behaviour for radius mode (#2737 item 2), mirroring
 * `measurementSlice.angle.test.ts`: the reset-home tests matter most, since
 * #2199's own regression was a hand-maintained reset list silently missing a
 * newly added field. Each reset is asserted by the VALUE it leaves behind.
 *
 * Radius is structurally closer to polyline than to angle — unbounded picks,
 * explicit finish gesture — so the finish-with-a-minimum and
 * finish-below-the-minimum-is-a-no-op tests mirror
 * `measurementSlice.polyline.test.ts`'s equivalents rather than angle's
 * self-finishing sequence.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createMeasurementSlice, type MeasurementSlice } from './measurementSlice.js';
import type { MeasurePoint } from '../types.js';

const P = (x: number, y: number, z: number): MeasurePoint => ({ x, y, z, screenX: 0, screenY: 0 });

describe('radius mode store (#2737 item 2)', () => {
  let state: MeasurementSlice;
  let setState: (
    partial: Partial<MeasurementSlice> | ((state: MeasurementSlice) => Partial<MeasurementSlice>),
  ) => void;
  let getState: () => MeasurementSlice;

  beforeEach(() => {
    setState = (partial) => {
      state = typeof partial === 'function'
        ? { ...state, ...partial(state) }
        : { ...state, ...partial };
    };
    getState = () => state;
    state = createMeasurementSlice(setState, getState, {} as never);
  });

  const s = () => state;

  it('startRadius begins a sequence; addRadiusPoint extends it', () => {
    s().setMeasureMode('radius');
    s().startRadius(P(0, 0, 0));
    assert.equal(s().activeRadius?.points.length, 1);
    s().addRadiusPoint(P(1, 0, 0));
    s().addRadiusPoint(P(1, 1, 0));
    assert.equal(s().activeRadius?.points.length, 3);
    assert.equal(s().radiusMeasurements.length, 0, 'must not finish itself — radius has no fixed count');
  });

  it('startRadius is a no-op once a sequence is already active', () => {
    s().startRadius(P(0, 0, 0));
    s().startRadius(P(9, 9, 9));
    assert.equal(s().activeRadius?.points.length, 1, 'a second start must not replace the sequence');
  });

  it('finishRadius below MIN_RADIUS_POINTS is a no-op that leaves the sequence intact', () => {
    s().setMeasureMode('radius');
    s().startRadius(P(0, 0, 0));
    s().addRadiusPoint(P(1, 0, 0));
    const recorded = s().finishRadius();
    assert.equal(recorded, false);
    assert.equal(s().radiusMeasurements.length, 0);
    assert.equal(s().activeRadius?.points.length, 2, 'the in-progress sequence must survive a rejected finish');
  });

  it('finishRadius at MIN_RADIUS_POINTS records a measurement and clears the sequence', () => {
    s().setMeasureMode('radius');
    s().startRadius(P(0, 0, 0));
    s().addRadiusPoint(P(1, 0, 0));
    s().addRadiusPoint(P(1, 1, 0));
    const recorded = s().finishRadius();
    assert.equal(recorded, true);
    assert.equal(s().activeRadius, null);
    assert.equal(s().radiusMeasurements.length, 1);
    assert.equal(s().radiusMeasurements[0].points.length, 3);
  });

  it('finishRadius with fromDoubleClick drops the trailing near-duplicate point', () => {
    s().setMeasureMode('radius');
    s().startRadius(P(0, 0, 0));
    s().addRadiusPoint(P(1, 0, 0));
    s().addRadiusPoint(P(1, 1, 0));
    // The browser's second click of a double-click lands a pixel or two from
    // the third pick — screenX/screenY, not world coordinates, are what
    // isDuplicateClickPoint compares.
    s().addRadiusPoint({ x: 1, y: 1, z: 0, screenX: 100, screenY: 100 });
    s().addRadiusPoint({ x: 1, y: 1, z: 0, screenX: 101, screenY: 100 });
    const recorded = s().finishRadius({ fromDoubleClick: true });
    assert.equal(recorded, true);
    assert.equal(s().radiusMeasurements[0].points.length, 4, 'exactly one trailing point must be dropped');
  });

  it('leaving radius mode discards an in-progress sequence', () => {
    s().setMeasureMode('radius');
    s().startRadius(P(0, 0, 0));
    assert.equal(s().activeRadius?.points.length, 1);
    s().setMeasureMode('drag');
    assert.equal(s().activeRadius, null);
  });

  it('entering radius mode cancels an in-progress drag measurement', () => {
    s().startMeasurement({ x: 1, y: 2, z: 3, screenX: 10, screenY: 20 });
    assert.notEqual(s().activeMeasurement, null, 'precondition: a drag is in progress');
    s().setMeasureMode('radius');
    assert.equal(s().activeMeasurement, null, 'switching to radius must cancel the drag');
    assert.equal(s().snapTarget, null);
  });

  it('cancelRadius discards the in-progress sequence without recording anything', () => {
    s().setMeasureMode('radius');
    s().startRadius(P(0, 0, 0));
    s().addRadiusPoint(P(1, 0, 0));
    s().cancelRadius();
    assert.equal(s().activeRadius, null);
    assert.equal(s().radiusMeasurements.length, 0);
  });

  it('clearMeasurements empties BOTH the finished list and the in-progress sequence', () => {
    s().setMeasureMode('radius');
    s().startRadius(P(0, 0, 0));
    s().addRadiusPoint(P(1, 0, 0));
    s().addRadiusPoint(P(1, 1, 0));
    s().finishRadius();
    s().startRadius(P(5, 5, 5));
    assert.equal(s().radiusMeasurements.length, 1);
    assert.equal(s().activeRadius?.points.length, 1);
    s().clearMeasurements();
    assert.deepEqual(s().radiusMeasurements, [], 'a finished radius must not survive "clear all"');
    assert.equal(s().activeRadius, null, 'a partial sequence left behind by clear is a stale trap');
  });

  it('resetMeasureGesture drops the in-progress sequence but keeps finished ones', () => {
    s().setMeasureMode('radius');
    s().startRadius(P(0, 0, 0));
    s().addRadiusPoint(P(1, 0, 0));
    s().addRadiusPoint(P(1, 1, 0));
    s().finishRadius();
    s().startRadius(P(5, 5, 5));
    s().resetMeasureGesture();
    assert.equal(s().activeRadius, null);
    assert.equal(s().radiusMeasurements.length, 1, 'leaving the tool must not delete measurements');
  });

  it('resetAllMeasurementState returns every radius field to its default', () => {
    s().setMeasureMode('radius');
    s().startRadius(P(0, 0, 0));
    s().addRadiusPoint(P(1, 0, 0));
    s().addRadiusPoint(P(1, 1, 0));
    s().finishRadius();
    s().resetAllMeasurementState();
    assert.equal(s().activeRadius, null);
    assert.deepEqual(s().radiusMeasurements, []);
  });

  it('deleteRadiusMeasurement removes only the named measurement', () => {
    s().setMeasureMode('radius');
    s().startRadius(P(0, 0, 0));
    s().addRadiusPoint(P(1, 0, 0));
    s().addRadiusPoint(P(1, 1, 0));
    s().finishRadius();
    s().startRadius(P(9, 0, 0));
    s().addRadiusPoint(P(10, 0, 0));
    s().addRadiusPoint(P(10, 1, 0));
    s().finishRadius();
    assert.equal(s().radiusMeasurements.length, 2);
    s().deleteRadiusMeasurement(s().radiusMeasurements[0].id);
    assert.equal(s().radiusMeasurements.length, 1);
  });
});
