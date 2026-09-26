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
const P = (x: number, y: number, screenX: number, screenY: number) => ({ x, y, z: 0, screenX, screenY });
const ANGLE = { id: 'ang-1', kind: 'points' as const, picks: [
  { kind: 'points' as const, point: P(1, 0, 10, 10) },
  { kind: 'points' as const, point: P(0, 0, 20, 20) },
  { kind: 'points' as const, point: P(0, 1, 30, 10) },
] };
const RADIUS = { id: 'rad-1', points: [P(1, 0, 10, 20), P(0, 1, 20, 10), P(-1, 0, 30, 20)] };

beforeEach(() => {
  useViewerStore.setState({
    activeTool: 'select',
    measurements: [],
    polylineMeasurements: [],
    angleMeasurements: [],
    radiusMeasurements: [],
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

  it('draws finished angle and radius picks after the Measure tool closes (#6144)', () => {
    useViewerStore.setState({ angleMeasurements: [ANGLE], radiusMeasurements: [RADIUS] });
    const container = render(<MeasurementSceneLayer />);
    assert.equal(container.querySelectorAll('path[stroke-dasharray="6,3"]').length, 2);
    assert.equal(container.querySelectorAll('circle').length, 6);
  });

  it('keeps angle and radius hidden after switching back into Measure (#6144)', () => {
    useViewerStore.setState({ angleMeasurements: [ANGLE], radiusMeasurements: [RADIUS], activeTool: 'measure',
      sceneState: { ...s().sceneState, measurements: { visible: false } } });
    const container = render(<><ViewportHud /><MeasureOverlay /><MeasurementSceneLayer /></>);
    assert.equal(container.querySelector('path[stroke-dasharray="6,3"]'), null);
  });

  it('reveals the scene after finishing an angle or radius (#6144)', () => {
    useViewerStore.setState({ sceneState: { ...s().sceneState, measurements: { visible: false } } });
    s().setAngleKind('points');
    for (const point of [P(1, 0, 10, 10), P(0, 0, 20, 20), P(0, 1, 30, 10)]) {
      s().addAnglePick({ kind: 'points', point });
    }
    assert.equal(s().sceneState.measurements.visible, true);
    s().setMeasurementsVisible(false);
    s().startRadius(P(1, 0, 10, 20));
    s().addRadiusPoint(P(0, 1, 20, 10));
    s().addRadiusPoint(P(-1, 0, 30, 20));
    assert.equal(s().finishRadius(), true);
    assert.equal(s().sceneState.measurements.visible, true);
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
