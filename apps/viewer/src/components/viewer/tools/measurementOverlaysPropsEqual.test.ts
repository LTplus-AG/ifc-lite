/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The memo comparator must react to WORLD coordinate changes, not only screen
 * ones (#2199 review).
 *
 * `MeasurementOverlays` renders the axis breakdown from `distanceComponents`,
 * which reads world x/y/z. The comparator originally compared `screenX`/
 * `screenY` only — correct while the label showed a single projected distance,
 * wrong the moment the label started deriving from world coords.
 *
 * The failure is reachable, not theoretical: two different world positions can
 * project to the SAME screen point whenever the movement is along the view ray
 * — dragging in depth, or snapping to a nearer/farther surface under a cursor
 * that has not moved a pixel. React then skips the re-render and the readout
 * keeps showing the previous dX/dY/dZ.
 *
 * A render test cannot catch this: the component renders correctly whenever it
 * renders at all. The bug is that it is not asked to.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { measurementOverlaysPropsEqual, type MeasurementOverlaysProps } from './MeasurementVisuals.js';

type Props = MeasurementOverlaysProps;

/** A measurement point: same screen position unless overridden. */
function pt(x: number, y: number, z: number, screenX = 100, screenY = 200) {
  return { x, y, z, screenX, screenY };
}

function props(over: Partial<Props> = {}): Props {
  return {
    measurements: [],
    pending: null,
    activeMeasurement: null,
    snapTarget: null,
    snapVisualization: null,
    hoverPosition: null,
    projectToScreen: undefined,
    constraintEdge: null,
    ...over,
  } as Props;
}

function completed(start: ReturnType<typeof pt>, end: ReturnType<typeof pt>) {
  return props({
    measurements: [{ id: 'm1', start, end, distance: 1 }] as unknown as Props['measurements'],
  });
}

describe('measurementOverlaysPropsEqual', () => {
  it('re-renders when a completed measurement moves in world space at the SAME screen position', () => {
    const a = completed(pt(0, 0, 0), pt(1, 0, 0));
    // Identical screen coords, different world Z — the depth-drag case.
    const b = completed(pt(0, 0, 0), pt(1, 0, 5));

    assert.equal(
      measurementOverlaysPropsEqual(a, b),
      false,
      'a world-only change must invalidate the memo, or the axis readout goes stale',
    );
  });

  // PER-AXIS, deliberately. A single case that moves one axis lets a mutation
  // neutering a DIFFERENT axis's comparison survive — the comparator is six
  // independent clauses for the active measurement, so each needs its own case
  // or the suite pins presence rather than correctness.
  for (const [axis, moved] of [
    ['x', pt(9, 0, 0)],
    ['y', pt(0, 9, 0)],
    ['z', pt(0, 0, 9)],
  ] as const) {
    it(`re-renders when the ACTIVE measurement's current.${axis} moves at the same screen position`, () => {
      const base = { start: pt(0, 0, 0), current: pt(0, 0, 0), distance: 1 };
      const a = props({ activeMeasurement: base as Props['activeMeasurement'] });
      const b = props({ activeMeasurement: { ...base, current: moved } as Props['activeMeasurement'] });

      assert.equal(measurementOverlaysPropsEqual(a, b), false);
    });

    it(`re-renders when the ACTIVE measurement's start.${axis} moves at the same screen position`, () => {
      const base = { start: pt(0, 0, 0), current: pt(1, 1, 1), distance: 1 };
      const a = props({ activeMeasurement: base as Props['activeMeasurement'] });
      const b = props({ activeMeasurement: { ...base, start: moved } as Props['activeMeasurement'] });

      assert.equal(measurementOverlaysPropsEqual(a, b), false);
    });
  }

  for (const [axis, moved] of [
    ['x', pt(9, 0, 0)],
    ['y', pt(0, 9, 0)],
    ['z', pt(0, 0, 9)],
  ] as const) {
    it(`re-renders when a completed measurement's end.${axis} moves at the same screen position`, () => {
      const a = completed(pt(0, 0, 0), pt(0, 0, 0));
      const b = completed(pt(0, 0, 0), moved);

      assert.equal(measurementOverlaysPropsEqual(a, b), false);
    });

    it(`re-renders when a completed measurement's start.${axis} moves at the same screen position`, () => {
      const a = completed(pt(0, 0, 0), pt(1, 1, 1));
      const b = completed(moved, pt(1, 1, 1));

      assert.equal(measurementOverlaysPropsEqual(a, b), false);
    });
  }

  it('still skips the re-render when nothing changed at all', () => {
    // The negative control: if this returns false, the comparator has stopped
    // discriminating and is just forcing every render, which would make the
    // three assertions above pass for the wrong reason.
    const a = completed(pt(0, 0, 0), pt(1, 2, 3));
    const b = completed(pt(0, 0, 0), pt(1, 2, 3));

    assert.equal(measurementOverlaysPropsEqual(a, b), true);
  });

  it('still re-renders on a screen-only change, as it always did', () => {
    const a = completed(pt(0, 0, 0), pt(1, 2, 3));
    const b = completed(pt(0, 0, 0), pt(1, 2, 3, 999, 999));

    assert.equal(measurementOverlaysPropsEqual(a, b), false);
  });

  // #2199: every distance label now routes through `unitDisplayOverrides`
  // (formatDistanceDisplay). Without this clause the memo would keep an old
  // measurement showing metres after the user switched the LENGTHUNIT
  // display override to feet — same class of staleness the world-coordinate
  // clauses above exist to prevent, just triggered by a store change instead
  // of a drag.
  it('re-renders when unitDisplayOverrides changes with no other prop different', () => {
    const a = completed(pt(0, 0, 0), pt(1, 2, 3));
    const withFeet = { ...a, unitDisplayOverrides: { LENGTHUNIT: 'ft' } };
    const empty = { ...a, unitDisplayOverrides: {} };

    assert.equal(measurementOverlaysPropsEqual(empty, withFeet), false);
    assert.equal(measurementOverlaysPropsEqual(withFeet, empty), false);
  });

  it('re-renders when switching between two different override units', () => {
    const a = { ...completed(pt(0, 0, 0), pt(1, 2, 3)), unitDisplayOverrides: { LENGTHUNIT: 'ft' } };
    const b = { ...completed(pt(0, 0, 0), pt(1, 2, 3)), unitDisplayOverrides: { LENGTHUNIT: 'mm' } };

    assert.equal(measurementOverlaysPropsEqual(a, b), false);
  });

  it('treats a missing unitDisplayOverrides the same as an empty one', () => {
    const a = completed(pt(0, 0, 0), pt(1, 2, 3)); // unitDisplayOverrides omitted
    const b = { ...a, unitDisplayOverrides: {} };

    assert.equal(measurementOverlaysPropsEqual(a, b), true);
  });

  it('still skips the re-render when unitDisplayOverrides is unchanged', () => {
    const a = { ...completed(pt(0, 0, 0), pt(1, 2, 3)), unitDisplayOverrides: { LENGTHUNIT: 'ft' } };
    const b = { ...completed(pt(0, 0, 0), pt(1, 2, 3)), unitDisplayOverrides: { LENGTHUNIT: 'ft' } };

    assert.equal(measurementOverlaysPropsEqual(a, b), true);
  });
});
