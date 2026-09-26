/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The measurements chip (#5893): a top-left HUD chip while the Measure tool
 * is closed and at least one measurement exists, with a visibility toggle
 * and a clear action. Mirrors `SectionParkedChip.test.tsx`'s conventions —
 * asserted on the DOM and the store after each action, never on wiring.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { MeasurementsVisibilityChip } from './MeasurementsVisibilityChip.js';

const s = () => useViewerStore.getState();

const A_MEASUREMENT = {
  id: 'm1',
  start: { x: 0, y: 0, z: 0, screenX: 10, screenY: 10 },
  end: { x: 3, y: 0, z: 0, screenX: 40, screenY: 10 },
  distance: 3,
};

beforeEach(() => {
  useViewerStore.setState({
    activeTool: 'select',
    measurements: [],
    polylineMeasurements: [],
    sceneState: { ...s().sceneState, measurements: { visible: true } },
  });
});

afterEach(() => cleanup());

const region = () => document.querySelector<HTMLElement>('[data-hud-region="top-left"]')!;
const chip = () => [...region().querySelectorAll<HTMLElement>('[data-hud-item]')].find((el) => el.querySelector('button[aria-label="Clear all measurements"]'));

describe('measurements chip (#5893)', () => {
  it('is absent with nothing measured, and while the Measure tool is open', () => {
    render(<><ViewportHud /><MeasurementsVisibilityChip /></>);
    assert.equal(chip(), undefined, 'nothing measured, no chip');
    act(() => useViewerStore.setState({ measurements: [A_MEASUREMENT], activeTool: 'measure' }));
    assert.equal(chip(), undefined, 'the Measure tool is open: its own bar carries the count');
  });

  it('shows the count once a measurement exists and the tool is closed', () => {
    render(<><ViewportHud /><MeasurementsVisibilityChip /></>);
    act(() => useViewerStore.setState({ measurements: [A_MEASUREMENT] }));
    assert.equal(chip()?.textContent?.trim(), '1 measured');
  });

  it('the eye toggle hides measurements without deleting them (#5893)', () => {
    render(<><ViewportHud /><MeasurementsVisibilityChip /></>);
    act(() => useViewerStore.setState({ measurements: [A_MEASUREMENT] }));
    click(chip()!.querySelector('button[aria-label="Hide measurements"]')!);
    assert.equal(s().sceneState.measurements.visible, false);
    assert.equal(s().measurements.length, 1, 'the data survives the hide');
    assert.ok(chip(), 'the chip stays — it is how measurements come back');
    click(chip()!.querySelector('button[aria-label="Show measurements"]')!);
    assert.equal(s().sceneState.measurements.visible, true);
  });

  it('clear deletes every measurement and the chip disappears', () => {
    render(<><ViewportHud /><MeasurementsVisibilityChip /></>);
    act(() => useViewerStore.setState({ measurements: [A_MEASUREMENT] }));
    click(chip()!.querySelector('button[aria-label="Clear all measurements"]')!);
    assert.equal(s().measurements.length, 0);
    assert.equal(chip(), undefined);
  });
});
