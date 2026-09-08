/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store behaviour for angle mode (#2735).
 *
 * The reset-home tests below are the ones that matter most. This slice
 * documents a #2199 regression where a hand-maintained reset list silently
 * missed newly added fields, so each reset is asserted by the VALUE it leaves
 * behind - deleting a field from a reset object flips a named test rather than
 * passing because nothing looked at it.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createMeasurementSlice, type MeasurementSlice } from './measurementSlice.js';
import type { AnglePick } from '../types.js';

const P = (x: number, y: number, z: number): AnglePick => ({
  kind: 'points',
  point: { x, y, z, screenX: 0, screenY: 0 },
});

describe('angle mode store (#2735)', () => {
  let state: MeasurementSlice;
  let setState: (
    partial: Partial<MeasurementSlice> | ((state: MeasurementSlice) => Partial<MeasurementSlice>),
  ) => void;
  let getState: () => MeasurementSlice;

  beforeEach(() => {
    // Typed shims rather than `as any`, matching the adjacent
    // `measurementSlice.test.ts`: an `any`-cast mock would let an incompatible
    // signature go undetected, which is the one thing a store test exists to
    // catch. Only the third argument (the zustand StoreApi, unused by this
    // slice) keeps its cast, as it does there.
    setState = (partial) => {
      state = typeof partial === 'function'
        ? { ...state, ...partial(state) }
        : { ...state, ...partial };
    };
    getState = () => state;
    state = createMeasurementSlice(setState, getState, {} as never);
  });

  const s = () => state;

  it('finishes itself on the THIRD pick and clears the in-progress sequence', () => {
    s().setMeasureMode('angle');
    s().addAnglePick(P(0, 0, 0));
    assert.equal(s().activeAngle?.picks.length, 1);
    s().addAnglePick(P(4, 0, 0));
    assert.equal(s().activeAngle?.picks.length, 2);
    assert.equal(s().angleMeasurements.length, 0, 'must not finish early');
    s().addAnglePick(P(0, 0, 3));
    assert.equal(s().activeAngle, null, 'the sequence must clear on completion');
    assert.equal(s().angleMeasurements.length, 1);
    assert.equal(s().angleMeasurements[0].picks.length, 3);
  });

  it('rejects a pick whose kind does not match the active angleKind', () => {
    s().setMeasureMode('angle');
    s().addAnglePick({ ...P(0, 0, 0), kind: 'edges' });
    assert.equal(s().activeAngle, null, 'a mismatched pick must not start a sequence');
  });

  it('leaving angle mode discards an in-progress sequence', () => {
    s().setMeasureMode('angle');
    s().addAnglePick(P(0, 0, 0));
    assert.equal(s().activeAngle?.picks.length, 1);
    s().setMeasureMode('drag');
    assert.equal(s().activeAngle, null);
  });

  it('entering angle mode cancels an IN-PROGRESS drag measurement', () => {
    // The earlier version of this test asserted `activeMeasurement === null`
    // straight after switching mode - but the slice STARTS with it null, so it
    // passed even if `setMeasureMode` stopped clearing drag state entirely.
    // A drag has to exist before cancelling it means anything.
    s().startMeasurement({ x: 1, y: 2, z: 3, screenX: 10, screenY: 20 });
    assert.notEqual(s().activeMeasurement, null, 'precondition: a drag is in progress');

    s().setMeasureMode('angle');
    assert.equal(s().activeMeasurement, null, 'switching to angle must cancel the drag');
    assert.equal(s().snapTarget, null);
  });

  it('switching angleKind discards the picks already taken', () => {
    s().setMeasureMode('angle');
    s().addAnglePick(P(0, 0, 0));
    s().setAngleKind('edges');
    assert.equal(s().activeAngle, null);
    assert.equal(s().angleKind, 'edges');
  });

  it('clearMeasurements empties BOTH the finished list and the in-progress sequence', () => {
    s().setMeasureMode('angle');
    s().addAnglePick(P(0, 0, 0));
    s().addAnglePick(P(4, 0, 0));
    s().addAnglePick(P(0, 0, 3));
    s().addAnglePick(P(1, 1, 1));
    assert.equal(s().angleMeasurements.length, 1);
    assert.equal(s().activeAngle?.picks.length, 1);
    s().clearMeasurements();
    assert.deepEqual(s().angleMeasurements, [], 'a finished angle must not survive "clear all"');
    assert.equal(s().activeAngle, null, 'a partial sequence left behind by clear is a stale trap');
  });

  it('resetMeasureGesture drops the in-progress sequence but keeps finished ones', () => {
    s().setMeasureMode('angle');
    s().addAnglePick(P(0, 0, 0));
    s().addAnglePick(P(4, 0, 0));
    s().addAnglePick(P(0, 0, 3));
    s().addAnglePick(P(1, 1, 1));
    s().resetMeasureGesture();
    assert.equal(s().activeAngle, null);
    assert.equal(s().angleMeasurements.length, 1, 'leaving the tool must not delete measurements');
  });

  it('resetAllMeasurementState returns every angle field to its default', () => {
    s().setMeasureMode('angle');
    s().setAngleKind('faces');
    s().addAnglePick({ ...P(0, 0, 0), kind: 'faces' });
    s().resetAllMeasurementState();
    assert.equal(s().angleKind, 'points', 'a new file is a new scene');
    assert.equal(s().activeAngle, null);
    assert.deepEqual(s().angleMeasurements, []);
  });

  it('deleteAngleMeasurement removes only the named measurement', () => {
    s().setMeasureMode('angle');
    for (const p of [P(0, 0, 0), P(4, 0, 0), P(0, 0, 3)]) s().addAnglePick(p);
    for (const p of [P(1, 0, 0), P(2, 0, 0), P(1, 0, 2)]) s().addAnglePick(p);
    assert.equal(s().angleMeasurements.length, 2);
    s().deleteAngleMeasurement(s().angleMeasurements[0].id);
    assert.equal(s().angleMeasurements.length, 1);
  });
});
