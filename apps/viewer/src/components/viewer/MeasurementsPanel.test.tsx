/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Measurements side panel (#5502): the list, point readout and
 * quantities work from the docked panel — numbers appear, rows delete
 * through the store, tabs switch bodies — and the panel is reachable when
 * the Measure tool is closed. Asserted on rendered output and store state.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, waitFor, mouseDown, press, advance } from '@/test/render.js';
import { loadDialogs } from '@/test/dialog-host.js';
import { useViewerStore } from '@/store/index.js';
import type { MeasurePoint } from '@/store/types.js';
import { MeasurementsPanel } from './MeasurementsPanel.js';

function mp(x: number, y: number, z: number): MeasurePoint {
  return { x, y, z, screenX: x, screenY: y };
}

/** Renderer (3, 3, -4) is IFC (3, 4, 3): a 3-4-5 run with a 3 m rise. */
const START = mp(0, 0, 0);
const END = mp(3, 3, -4);
const M1 = { id: 'm1', start: START, end: END, distance: Math.hypot(3, 3, 4) };
const M2 = { id: 'm2', start: START, end: mp(2, 0, 0), distance: 2 };

beforeEach(() => {
  useViewerStore.setState({
    activeTool: 'measure',
    measurements: [],
    activeMeasurement: null,
    angleMeasurements: [],
    activeAngle: null,
    activePolyline: null,
    polylineMeasurements: [{ id: 'pl1', points: [mp(0, 0, 0), mp(3, 4, 0)], closed: true, length: 5 }],
    radiusMeasurements: [],
    activeRadius: null,
    measureReferencePoint: null,
    selectedEntity: null,
    selectedEntitiesSet: new Set<string>(),
    unitDisplayOverrides: {},
    placementStaleMeasurements: new Set<string>(),
  });
});

afterEach(() => {
  cleanup();
});

function tab(container: HTMLElement, label: string): Element {
  const el = [...container.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.trim() === label);
  assert.ok(el, `no "${label}" tab`);
  return el;
}

describe('Measurements panel (#5502)', () => {
  it('lists every kind with its total and deletes a row through the store', () => {
    useViewerStore.setState({ measurements: [M1, M2] });
    const container = render(<MeasurementsPanel />);
    const text = container.textContent ?? '';
    assert.match(text, /#1.*5\.831 m/, `first distance missing: ${text}`);
    assert.match(text, /Total \(current\)\s*7\.831 m/, `total missing: ${text}`);
    assert.match(text, /Poly #1 · Perimeter \(closed\)\s*5\.000 m/, `closed polyline basis missing: ${text}`);
    // Header count spans every kind, not just distances.
    assert.match(container.querySelector('.border-b')?.textContent ?? '', /Measurements\s*3/);

    const firstRow = [...container.querySelectorAll('div')].find((d) => d.textContent?.startsWith('#1'));
    assert.ok(firstRow);
    click(firstRow.querySelector('button')!);
    assert.deepEqual(useViewerStore.getState().measurements.map((m) => m.id), ['m2']);
    assert.doesNotMatch(container.textContent ?? '', /Total \(current\)/, 'one measurement left: no total row');
  });

  it('Point tab reads the last endpoint in IFC axes; Qty tab answers for an empty selection', () => {
    useViewerStore.setState({ measurements: [M1] });
    const container = render(<MeasurementsPanel />);
    mouseDown(tab(container, 'Point'));
    assert.match(container.textContent ?? '', /X 3\.000\s+Y 4\.000\s+Z 3\.000/, container.textContent ?? '');
    assert.equal(tab(container, 'Point').getAttribute('aria-selected'), 'true');
    mouseDown(tab(container, 'Qty'));
    assert.match(container.textContent ?? '', /Select elements to read their quantities/);
    assert.doesNotMatch(container.textContent ?? '', /X 3\.000/);
  });

  it('#5815 ArrowRight selects Point and ties its readout to the tab', async () => {
    useViewerStore.setState({ measurements: [M1] });
    const container = render(<MeasurementsPanel />);
    const list = tab(container, 'List') as HTMLElement;
    list.focus();
    press(list, 'ArrowRight');
    await advance(5);
    const point = tab(container, 'Point') as HTMLElement;
    assert.equal(document.activeElement, point);
    assert.equal(point.getAttribute('aria-selected'), 'true');
    const panel = container.querySelector('[role="tabpanel"][data-state="active"]');
    assert.ok(panel);
    assert.equal(panel.getAttribute('aria-labelledby'), point.id);
    assert.match(panel.textContent ?? '', /X 3\.000/);
  });

  it('offers to start measuring from an empty list only while the tool is closed', () => {
    useViewerStore.setState({ activeTool: 'select', polylineMeasurements: [] });
    const container = render(<MeasurementsPanel />);
    assert.match(container.textContent ?? '', /No measurements/);
    const start = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Start measuring'));
    assert.ok(start, 'no "Start measuring" affordance');
    click(start);
    assert.equal(useViewerStore.getState().activeTool, 'measure');
    assert.equal(
      [...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Start measuring')),
      false,
      'the affordance must disappear once the tool is active',
    );
  });

  it('Clear all asks first and clears every kind when accepted', async () => {
    const { ConfirmDialogHost } = await loadDialogs();
    useViewerStore.setState({ measurements: [M1] });
    const container = render(<><MeasurementsPanel /><ConfirmDialogHost /></>);
    const clear = container.querySelector('button[title="Clear all"]');
    assert.ok(clear);
    click(clear);
    let dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /Clear every measurement\? This cannot be undone\./);
    assert.equal(useViewerStore.getState().measurements.length, 1, 'declined: nothing cleared');
    click(dialog.querySelector('button')!);
    click(clear);
    dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    click(dialog.querySelectorAll('button')[1]);
    await waitFor(() => useViewerStore.getState().measurements.length === 0, 'accepted clear removes measurements');
    assert.equal(useViewerStore.getState().measurements.length, 0);
    assert.equal(useViewerStore.getState().polylineMeasurements.length, 0);
    assert.equal(container.querySelector('button[title="Clear all"]'), null, 'nothing left to clear');
  });

  it('close goes through the host callback', () => {
    let closed = 0;
    const container = render(<MeasurementsPanel onClose={() => { closed += 1; }} />);
    click(container.querySelector('button[title="Close panel"]')!);
    assert.equal(closed, 1);
  });
});
