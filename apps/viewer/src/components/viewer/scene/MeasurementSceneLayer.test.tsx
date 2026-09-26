/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `MeasurementSceneLayer` (#5893): mounted unconditionally (unlike
 * `MeasureOverlay`, tool-gated), it must still draw finished measurements
 * once the Measure tool closes, and must not double-draw while it is open.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { MeasurementSceneLayer } from './MeasurementSceneLayer.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { MeasureOverlay } from '../tools/MeasurePanel.js';

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

describe('MeasurementSceneLayer (#5893)', () => {
  it('renders nothing with no finished measurements', () => {
    const container = render(<MeasurementSceneLayer />);
    assert.equal(container.querySelector('svg'), null);
  });

  it('draws a finished measurement while the Measure tool is closed', () => {
    useViewerStore.setState({ measurements: [A_MEASUREMENT] });
    const container = render(<MeasurementSceneLayer />);
    assert.ok(container.querySelector('svg'), 'the overlay SVG mounts outside the tool (#5893)');
  });

  it('renders nothing while the Measure tool is open, to avoid double-drawing with MeasureOverlay', () => {
    useViewerStore.setState({ measurements: [A_MEASUREMENT], activeTool: 'measure' });
    const container = render(<MeasurementSceneLayer />);
    assert.equal(container.querySelector('svg'), null);
  });

  it('renders nothing while hidden by the visibility toggle', () => {
    useViewerStore.setState({
      measurements: [A_MEASUREMENT],
      sceneState: { ...s().sceneState, measurements: { visible: false } },
    });
    const container = render(<MeasurementSceneLayer />);
    assert.equal(container.querySelector('svg'), null);
  });

  it('keeps finished measurements hidden when the Measure tool opens (#5893)', () => {
    useViewerStore.setState({
      activeTool: 'measure',
      measurements: [A_MEASUREMENT],
      sceneState: { ...s().sceneState, measurements: { visible: false } },
    });
    const container = render(<><ViewportHud /><MeasureOverlay /><MeasurementSceneLayer /></>);
    assert.equal(container.querySelector('line[stroke-dasharray="6,3"]'), null);
    assert.equal(s().measurements.length, 1, 'the hide toggle preserves the finished measurement');
  });
});
