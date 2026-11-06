/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where focus goes when the live row of an open Polyline or Radius goes away
 * while it holds focus (#9041). Finish lands on the row it recorded, named by
 * its label and value (not its delete button, which a second Enter would
 * press); anything that records nothing (Cancel, Esc) lands on the list. A
 * Finish or Cancel that never had focus in the row (Enter or Esc from the
 * canvas, a click that does not focus the button) leaves focus where it was.
 *
 * Mounts the real Measurements panel beside the real keyboard shortcuts, so
 * Enter on a focused Finish runs through the same `measure.finish` command a
 * user's key does. Focus is reported as an accessible name or id string, never
 * as a DOM node.
 */

import '@/test/setup-dom.js';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, press, activate } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import type { MeasurePoint } from '@/store/types.js';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts.js';
import { MeasurementsPanel } from '../MeasurementsPanel.js';

function mp(x: number, y: number, z: number): MeasurePoint {
  return { x, y, z, screenX: x, screenY: y };
}

const PL1 = { id: 'pl1', points: [mp(0, 0, 0), mp(3, 4, 0)], closed: true, length: 5 };
const OPEN_POLYLINE = { points: [mp(0, 0, 0), mp(1, 0, 0), mp(1, 1, 0)] };
const OPEN_RADIUS = { points: [mp(1, 0, 0), mp(0, 1, 0), mp(-1, 0, 0)] };

const originalState = useViewerStore.getState();
after(() => { useViewerStore.setState(originalState, true); });

beforeEach(() => {
  useViewerStore.setState({
    activeTool: 'measure',
    measureMode: 'polyline',
    pointerInput: 'mouse',
    measurements: [],
    activeMeasurement: null,
    angleMeasurements: [],
    activeAngle: null,
    activePolyline: null,
    polylineMeasurements: [],
    radiusMeasurements: [],
    activeRadius: null,
    selectedEntity: null,
    selectedEntityId: null,
    selectedEntityIds: new Set<number>(),
    selectedEntitiesSet: new Set<string>(),
    unitDisplayOverrides: {},
    placementStaleMeasurements: new Set<string>(),
  });
});

afterEach(() => {
  cleanup();
});

function Shortcuts(): null {
  useKeyboardShortcuts();
  return null;
}

/** The panel, the shortcuts, and a focusable stand-in for the viewport canvas. */
function mount(): HTMLElement {
  return render(
    <>
      <Shortcuts />
      <canvas id="viewport-canvas" tabIndex={-1} />
      <MeasurementsPanel />
    </>,
  );
}

/**
 * What has focus: its accessible name (`aria-label`, else the text its
 * `aria-labelledby` points at), else its id, else `body`. Happy DOM focuses
 * any connected element, so an element a browser would refuse to focus is
 * flagged in the string.
 */
function focused(): string {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  const focusable = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.hasAttribute('tabindex');
  const labelledBy = el.getAttribute('aria-labelledby')?.split(' ')
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '?').join(' ');
  const name = el.getAttribute('aria-label') ?? labelledBy ?? (el.id || el.tagName.toLowerCase());
  return focusable ? name : `${name} (not focusable)`;
}

function button(container: HTMLElement, label: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
  assert.equal(el !== null, true, `no "${label}" button`);
  return el!;
}

function canvas(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('#viewport-canvas')!;
}

describe('the live row hands focus on when it goes away (#9041)', () => {
  it('Enter on a focused Finish lands on the recorded polyline row', () => {
    useViewerStore.setState({ polylineMeasurements: [PL1], activePolyline: OPEN_POLYLINE });
    const container = mount();
    activate(button(container, 'Finish (Enter)'), 'Enter');
    assert.equal(useViewerStore.getState().polylineMeasurements.length, 2, 'Enter recorded the polyline');
    assert.equal(focused(), 'Poly #2 · Length 2.000 m');
  });

  it('a second Enter after Finish keeps the recorded measurement', () => {
    useViewerStore.setState({ activePolyline: OPEN_POLYLINE });
    const container = mount();
    activate(button(container, 'Finish (Enter)'), 'Enter');
    const target = document.activeElement as HTMLElement;
    activate(target, 'Enter');
    press(target, 'Enter', { repeat: true });
    assert.equal(useViewerStore.getState().polylineMeasurements.length, 1, 'the repeat Enter deleted nothing');
    assert.equal(focused(), 'Poly #1 · Length 2.000 m');
  });

  it('Space on a focused Finish lands on the recorded radius row, past rows of every kind', () => {
    useViewerStore.setState({
      measureMode: 'radius',
      polylineMeasurements: [PL1],
      radiusMeasurements: [{ id: 'r1', points: OPEN_RADIUS.points }],
      activeRadius: OPEN_RADIUS,
    });
    const container = mount();
    activate(button(container, 'Finish (Enter)'), ' ');
    assert.equal(useViewerStore.getState().activeRadius, null, 'Space finished the radius');
    assert.equal(useViewerStore.getState().radiusMeasurements.length, 2);
    assert.match(focused(), /^Radius #2 \S/, 'the recorded radius row, by its label and value');
  });

  it('Space on a focused Cancel lands on the list', () => {
    useViewerStore.setState({ polylineMeasurements: [PL1], activePolyline: OPEN_POLYLINE });
    const container = mount();
    activate(button(container, 'Cancel (Esc)'), ' ');
    assert.equal(useViewerStore.getState().activePolyline, null, 'Space cancelled the polyline');
    assert.equal(useViewerStore.getState().polylineMeasurements.length, 1, 'nothing recorded');
    assert.equal(focused(), 'Measurements taken');
  });

  it('Cancel with no other rows lands on the emptied list', () => {
    useViewerStore.setState({ measureMode: 'radius', activeRadius: OPEN_RADIUS });
    const container = mount();
    activate(button(container, 'Cancel (Esc)'), ' ');
    assert.equal(useViewerStore.getState().activeRadius, null);
    assert.match(container.textContent ?? '', /No measurements/, 'the list is empty');
    assert.equal(focused(), 'Measurements taken');
  });

  it('Esc while a live-row button has focus lands on the list', () => {
    useViewerStore.setState({ activePolyline: OPEN_POLYLINE });
    const container = mount();
    const finish = button(container, 'Finish (Enter)');
    // Focused inside act, as a user's Tab is: the button's tooltip opens, and
    // its own Escape handler may take the first press.
    act(() => { finish.focus(); });
    let presses = 0;
    while (useViewerStore.getState().activePolyline !== null && presses < 2) {
      press(document.activeElement ?? finish, 'Escape');
      presses += 1;
    }
    assert.equal(useViewerStore.getState().activePolyline, null, `Esc cancelled the polyline (${presses} presses)`);
    assert.equal(focused(), 'Measurements taken');
  });

  it('a Finish that records nothing keeps the row, and focus on Finish', () => {
    useViewerStore.setState({ activePolyline: { points: [mp(0, 0, 0)] } });
    const container = mount();
    activate(button(container, 'Finish (Enter)'), ' ');
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 1, 'the one-point polyline stays open');
    assert.equal(focused(), 'Finish (Enter)');
  });

  for (const key of ['Enter', 'Escape'] as const) {
    it(`${key} from the canvas leaves focus on the canvas`, () => {
      useViewerStore.setState({ polylineMeasurements: [PL1], activePolyline: OPEN_POLYLINE });
      const container = mount();
      const target = canvas(container);
      target.focus();
      press(target, key);
      assert.equal(useViewerStore.getState().activePolyline, null, `${key} ended the polyline`);
      assert.equal(focused(), 'viewport-canvas');
    });

    it(`${key} with nothing focused leaves focus on the page`, () => {
      useViewerStore.setState({ measureMode: 'radius', activeRadius: OPEN_RADIUS });
      mount();
      (document.activeElement as HTMLElement | null)?.blur();
      press(window, key);
      assert.equal(useViewerStore.getState().activeRadius, null, `${key} ended the radius`);
      assert.equal(focused(), 'body');
    });
  }

  for (const pointerInput of ['mouse', 'touch'] as const) {
    it(`a ${pointerInput} press that focuses Finish lands on the recorded row`, () => {
      useViewerStore.setState({ pointerInput, activePolyline: OPEN_POLYLINE });
      const container = mount();
      // Chromium focuses a button on mouse down and on tap, before the click.
      const finish = button(container, 'Finish (Enter)');
      finish.focus();
      click(finish);
      assert.equal(useViewerStore.getState().polylineMeasurements.length, 1);
      assert.equal(focused(), 'Poly #1 · Length 2.000 m');
    });

    it(`a ${pointerInput} press that does not focus Cancel leaves focus where it was`, () => {
      useViewerStore.setState({ pointerInput, activePolyline: OPEN_POLYLINE });
      const container = mount();
      // Safari (macOS and iOS) does not focus a button it clicks or taps; the
      // press focuses the nearest focusable ancestor, the list, instead.
      const list = container.querySelector<HTMLElement>('[role="group"][aria-label="Measurements taken"]')!;
      list.focus();
      act(() => { button(container, 'Cancel (Esc)').click(); });
      assert.equal(useViewerStore.getState().activePolyline, null, 'the press cancelled the polyline');
      assert.equal(focused(), 'Measurements taken');
    });
  }
});
