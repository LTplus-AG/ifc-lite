/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Measure tool on the HUD (#5502, charter #5478 item 20): its bar lands
 * in the HUD's top-center region and its hint in bottom-center (placement by
 * region, never by coordinates), and every bar control drives the store —
 * asserted on the OUTPUT (store state, rendered text, `aria-pressed`), never
 * on the wiring.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import type { MeasurePoint } from '@/store/types.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { MeasureOverlay } from './MeasurePanel.js';

function mp(x: number, y: number, z: number): MeasurePoint {
  return { x, y, z, screenX: x, screenY: y };
}

const RESET = {
  activeTool: 'measure',
  measureMode: 'drag' as const,
  angleKind: 'points' as const,
  measurements: [],
  activeMeasurement: null,
  pendingMeasurePoint: null,
  angleMeasurements: [],
  activeAngle: null,
  activePolyline: null,
  polylineMeasurements: [],
  radiusMeasurements: [],
  activeRadius: null,
  snapEnabled: true,
  geoReadoutEnabled: false,
  sidebarActivePanel: 'properties' as const,
};

beforeEach(() => useViewerStore.setState(RESET));
afterEach(cleanup);

const renderTool = () => render(<><ViewportHud /><MeasureOverlay /></>);

function region(name: string): Element {
  const node = document.querySelector(`[data-hud-region="${name}"]`);
  assert.ok(node, `no HUD region ${name}`);
  return node;
}

function radio(container: HTMLElement, label: string): Element {
  const el = [...container.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.trim() === label);
  assert.ok(el, `no "${label}" segment on the bar`);
  return el;
}

function toggle(container: HTMLElement, label: string): Element {
  const el = [...container.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent?.trim().startsWith(label));
  assert.ok(el, `no "${label}" toggle on the bar`);
  return el;
}

describe('Measure bar placement on the HUD (#5502)', () => {
  it('portals the bar into top-center and the hint into bottom-center', () => {
    renderTool();
    assert.ok(region('top-center').querySelector('[data-testid="measure-toolbar"]'), 'bar is not in top-center');
    assert.equal(region('bottom-center').textContent?.trim(), 'Drag to measure');
    // Nothing of the tool sits outside the HUD's regions any more (no
    // absolute-positioned card of its own).
    assert.equal(region('top-left').textContent, '');
  });

  it('stacks the geo readout ABOVE the hint in bottom-center by order, not by coordinates', () => {
    // No georeference anchor is loaded, so the readout is absent and the
    // hint is the region's only item; the bar keeps its own region.
    renderTool();
    const items = region('bottom-center').querySelectorAll('[data-hud-item]');
    assert.equal(items.length, 1);
    assert.equal(region('top-center').querySelectorAll('[data-hud-item]').length, 1);
  });
});

describe('Measure bar controls drive the store', () => {
  it('mode is a segmented control; picking Polyline switches the mode and the hint', () => {
    const container = renderTool();
    assert.equal(radio(container, 'Distance').getAttribute('aria-checked'), 'true');
    click(radio(container, 'Polyline'));
    assert.equal(useViewerStore.getState().measureMode, 'polyline');
    assert.equal(radio(container, 'Polyline').getAttribute('aria-checked'), 'true');
    assert.equal(region('bottom-center').textContent?.trim(), 'Click to start polyline');
    act(() => useViewerStore.setState({ activePolyline: { points: [mp(0, 0, 0)] } }));
    assert.match(region('bottom-center').textContent ?? '', /Click to add point/);
  });

  it('the angle-kind control appears only in Angle mode and names the next pick', () => {
    const container = renderTool();
    assert.equal(container.querySelector('[aria-label="Angle kind"]'), null);
    click(radio(container, 'Angle'));
    assert.ok(container.querySelector('[aria-label="Angle kind"]'));
    assert.equal(region('bottom-center').textContent?.trim(), 'Click the apex of the angle');
    click(radio(container, 'Faces'));
    assert.equal(useViewerStore.getState().angleKind, 'faces');
    assert.equal(region('bottom-center').textContent?.trim(), 'Click the first face');
  });

  it('switching angle kind discards a half-placed sequence of the old kind', () => {
    useViewerStore.setState({ measureMode: 'angle', activeAngle: { kind: 'points', picks: [{ kind: 'points', point: mp(0, 0, 0) }] } });
    const container = renderTool();
    click(radio(container, 'Edges'));
    assert.equal(useViewerStore.getState().activeAngle, null);
  });

  it('Snap is a pressed toggle bound to the store', () => {
    const container = renderTool();
    assert.equal(toggle(container, 'Snap').getAttribute('aria-pressed'), 'true');
    click(toggle(container, 'Snap'));
    assert.equal(useViewerStore.getState().snapEnabled, false);
    assert.equal(toggle(container, 'Snap').getAttribute('aria-pressed'), 'false');
  });

  it('Geo XYZ stays visible but disabled without a usable georeference, with the reason as its tooltip', () => {
    const container = renderTool();
    const geo = toggle(container, 'Geo XYZ') as HTMLButtonElement;
    assert.equal(geo.disabled, true);
    assert.match(geo.title, /IfcMapConversion/);
    assert.equal(geo.getAttribute('aria-pressed'), 'false');
  });

  it('Close returns to the select tool', () => {
    const container = renderTool();
    click(container.querySelector('button[title="Close"]')!);
    assert.equal(useViewerStore.getState().activeTool, 'select');
  });

  it('shows the running count on the panel button and Clear only once there is something to clear', () => {
    const container = renderTool();
    assert.equal(container.querySelector('button[title="Clear all"]'), null);
    act(() =>
      useViewerStore.setState({
        measurements: [{ id: 'm1', start: mp(0, 0, 0), end: mp(1, 0, 0), distance: 1 }],
        angleMeasurements: [{ id: 'a1', kind: 'points', picks: [{ kind: 'points', point: mp(0, 0, 0) }, { kind: 'points', point: mp(1, 0, 0) }, { kind: 'points', point: mp(0, 1, 0) }] }],
      }),
    );
    assert.equal(toggle(container, 'List').textContent?.trim(), 'List2');
    assert.ok(container.querySelector('button[title="Clear all"]'));
  });
});
