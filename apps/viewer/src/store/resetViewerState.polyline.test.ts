/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2641 review defect: `resetViewerState` (`store/index.ts`, "Measurements"
 * block) clears `measurements`, `activeMeasurement`, `snapTarget` and
 * `measureReferencePoint` but never touched `activePolyline`,
 * `polylineMeasurements` or `measureMode`. Switching to a new model left the
 * previous model's world-space polylines (finished and in-progress) alive,
 * rendered against the new scene — the "clearing persisted state has to hit
 * every home" class the slice's own `clearMeasurements` doc comment warns
 * about.
 *
 * This is a real, unmocked `useViewerStore` (not a hand-rolled slice mock):
 * `resetViewerState` reaches across every slice, so a mock would just
 * re-assert the fields the author remembered rather than catching an
 * omission.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from './index.js';

const p = (x: number, y: number, z: number) => ({ x, y, z, screenX: x * 10, screenY: y * 10 });

describe('resetViewerState — clears every polyline measurement home', () => {
  it('drops a finished polyline measurement from the outgoing model', () => {
    const s = useViewerStore.getState();
    s.startPolyline(p(0, 0, 0));
    s.addPolylinePoint(p(1, 0, 0));
    s.finishPolyline(false);
    assert.strictEqual(useViewerStore.getState().polylineMeasurements.length, 1, 'precondition');

    useViewerStore.getState().resetViewerState();

    assert.deepStrictEqual(
      useViewerStore.getState().polylineMeasurements,
      [],
      'a finished polyline from the outgoing model must not render against the new one',
    );
  });

  it('discards an in-progress polyline click sequence', () => {
    useViewerStore.getState().startPolyline(p(0, 0, 0));
    useViewerStore.getState().addPolylinePoint(p(1, 0, 0));
    assert.ok(useViewerStore.getState().activePolyline, 'precondition');

    useViewerStore.getState().resetViewerState();

    assert.strictEqual(useViewerStore.getState().activePolyline, null);
  });

  it('resets measureMode back to the drag default', () => {
    useViewerStore.getState().setMeasureMode('polyline');
    assert.strictEqual(useViewerStore.getState().measureMode, 'polyline', 'precondition');

    useViewerStore.getState().resetViewerState();

    assert.strictEqual(
      useViewerStore.getState().measureMode,
      'drag',
      'a stale polyline mode must not carry into the next model — the click-routing gate is keyed on it',
    );
  });

  it('still clears the pre-existing drag-mode fields (no regression)', () => {
    useViewerStore.getState().startMeasurement(p(0, 0, 0));
    useViewerStore.getState().updateMeasurement(p(1, 0, 0));
    useViewerStore.getState().finalizeMeasurement();
    assert.strictEqual(useViewerStore.getState().measurements.length, 1, 'precondition');

    useViewerStore.getState().resetViewerState();

    assert.deepStrictEqual(useViewerStore.getState().measurements, []);
    assert.strictEqual(useViewerStore.getState().activeMeasurement, null);
  });
});
