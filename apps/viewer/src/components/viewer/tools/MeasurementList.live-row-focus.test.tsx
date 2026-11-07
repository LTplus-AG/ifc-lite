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
  const parts = el.getAttribute('aria-labelledby')?.split(' ')
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '');
  // A reference to a missing or empty element names nothing: say so, rather
  // than return a partial name a loose pattern could still match.
  const labelledBy = parts && (parts.every(Boolean) ? parts.join(' ') : '(broken aria-labelledby)');
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
      measurements: [{ id: 'm1', start: mp(0, 0, 0), end: mp(2, 0, 0), distance: 2 }],
      polylineMeasurements: [PL1],
      angleMeasurements: [{ id: 'a1', kind: 'points', picks: [
        { kind: 'points', point: mp(0, 0, 0) }, { kind: 'points', point: mp(1, 0, 0) }, { kind: 'points', point: mp(0, 1, 0) },
      ] }],
      radiusMeasurements: [{ id: 'r1', points: OPEN_RADIUS.points }],
      activeRadius: OPEN_RADIUS,
    });
    const container = mount();
    activate(button(container, 'Finish (Enter)'), ' ');
    assert.equal(useViewerStore.getState().activeRadius, null, 'Space finished the radius');
    assert.equal(useViewerStore.getState().radiusMeasurements.length, 2);
    // The value is the fitted radius, "R …" with a length; only its shape is pinned here.
    const name = focused();
    assert.match(name, /^Radius #2 \S.*\d/, 'the recorded radius row, by its label and value');
    assert.equal(name.endsWith('(not focusable)'), false, `a browser could focus it: ${name}`);
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
      const list = container.querySelector<HTMLElement>('fieldset[aria-label="Measurements taken"]')!;
      list.focus();
      act(() => { button(container, 'Cancel (Esc)').click(); });
      assert.equal(useViewerStore.getState().activePolyline, null, 'the press cancelled the polyline');
      assert.equal(focused(), 'Measurements taken');
    });
  }
});

/** True while a tooltip is open: the precondition of the one-Esc tests. */
function tooltipOpen(): boolean {
  return document.querySelector('[role="tooltip"]') !== null;
}

/** Focus `el` the way a user's Tab does: inside act, so its tooltip opens. */
function tabTo(el: HTMLElement): void {
  act(() => { el.focus(); });
}

describe('a focused button acts on its own Enter (#9113)', () => {
  for (const [mode, open] of [['polyline', { activePolyline: OPEN_POLYLINE }], ['radius', { activeRadius: OPEN_RADIUS }]] as const) {
    it(`Enter on a focused Cancel cancels the open ${mode}`, () => {
      useViewerStore.setState({ measureMode: mode, polylineMeasurements: [PL1], ...open });
      const container = mount();
      activate(button(container, 'Cancel (Esc)'), 'Enter');
      const state = useViewerStore.getState();
      assert.equal(mode === 'polyline' ? state.activePolyline : state.activeRadius, null, `Enter ended the ${mode}`);
      assert.equal(state.polylineMeasurements.length + state.radiusMeasurements.length, 1, 'nothing recorded');
      assert.equal(focused(), 'Measurements taken');
    });
  }

  it('Enter on a focused Finish records the polyline once', () => {
    useViewerStore.setState({ activePolyline: OPEN_POLYLINE });
    const container = mount();
    activate(button(container, 'Finish (Enter)'), 'Enter');
    assert.equal(useViewerStore.getState().polylineMeasurements.length, 1);
    assert.equal(useViewerStore.getState().activePolyline, null);
  });

  it('Enter on a focused delete button deletes that row and leaves the open polyline open', () => {
    useViewerStore.setState({ polylineMeasurements: [PL1], activePolyline: OPEN_POLYLINE });
    const container = mount();
    activate(button(container, 'Delete polyline measurement 1'), 'Enter');
    assert.equal(useViewerStore.getState().polylineMeasurements.length, 0, 'Enter deleted the row');
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 3, 'the open polyline was not finished');
  });
});

describe('one Esc on a focused live-row button cancels (#9169)', () => {
  for (const label of ['Finish (Enter)', 'Cancel (Esc)']) {
    it(`one Esc on ${label} with its tooltip open cancels the polyline`, () => {
      useViewerStore.setState({ polylineMeasurements: [PL1], activePolyline: OPEN_POLYLINE });
      const container = mount();
      tabTo(button(container, label));
      assert.equal(tooltipOpen(), true, 'focus opened the tooltip');
      press(document.activeElement ?? window, 'Escape');
      assert.equal(useViewerStore.getState().activePolyline, null, 'the first Esc cancelled the polyline');
      assert.equal(useViewerStore.getState().polylineMeasurements.length, 1, 'nothing recorded');
      assert.equal(tooltipOpen(), false, 'the tooltip closed');
      assert.equal(focused(), 'Measurements taken');
    });
  }

  it('one Esc on a focused radius Cancel cancels the radius', () => {
    useViewerStore.setState({ measureMode: 'radius', activeRadius: OPEN_RADIUS });
    const container = mount();
    tabTo(button(container, 'Cancel (Esc)'));
    assert.equal(tooltipOpen(), true, 'focus opened the tooltip');
    press(document.activeElement ?? window, 'Escape');
    assert.equal(useViewerStore.getState().activeRadius, null);
    assert.equal(useViewerStore.getState().radiusMeasurements.length, 0);
  });

  it('elsewhere the first Esc still only closes the tooltip', () => {
    useViewerStore.setState({ polylineMeasurements: [PL1], activePolyline: OPEN_POLYLINE });
    const container = mount();
    tabTo(button(container, 'Delete polyline measurement 1'));
    assert.equal(tooltipOpen(), true, 'focus opened the tooltip');
    press(document.activeElement ?? window, 'Escape');
    assert.equal(tooltipOpen(), false, 'the tooltip closed');
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 3, 'the first Esc left the polyline open');
    press(document.activeElement ?? window, 'Escape');
    assert.equal(useViewerStore.getState().activePolyline, null, 'the second Esc cancelled it');
  });
});

describe('a deleted row hands focus on (#9124)', () => {
  const PL2 = { id: 'pl2', points: [mp(0, 0, 0), mp(6, 8, 0)], closed: false, length: 10 };
  const PL3 = { id: 'pl3', points: [mp(0, 0, 0), mp(0, 3, 0)], closed: false, length: 3 };
  const D1 = { id: 'm1', start: mp(0, 0, 0), end: mp(2, 0, 0), distance: 2 };
  const D2 = { id: 'm2', start: mp(0, 0, 0), end: mp(7, 0, 0), distance: 7 };

  for (const key of [' ', 'Enter'] as const) {
    it(`${key === ' ' ? 'Space' : 'Enter'} on a focused delete lands on the next row`, () => {
      useViewerStore.setState({ polylineMeasurements: [PL1, PL2, PL3] });
      const container = mount();
      activate(button(container, 'Delete polyline measurement 2'), key);
      assert.deepEqual(useViewerStore.getState().polylineMeasurements.map((m) => m.id), ['pl1', 'pl3']);
      // pl3, renumbered: the row after the deleted one.
      assert.equal(focused(), 'Poly #2 · Length 3.000 m');
    });
  }

  it('deleting the last row lands on the previous row', () => {
    useViewerStore.setState({ polylineMeasurements: [PL1, PL2] });
    const container = mount();
    activate(button(container, 'Delete polyline measurement 2'), ' ');
    assert.deepEqual(useViewerStore.getState().polylineMeasurements.map((m) => m.id), ['pl1']);
    assert.match(focused(), /^Poly #1 · \S.* 5\.000 m$/);
  });

  it('the next row may be of another kind', () => {
    useViewerStore.setState({ measurements: [D1, D2], polylineMeasurements: [PL2] });
    const container = mount();
    activate(button(container, 'Delete distance measurement 2'), ' ');
    assert.deepEqual(useViewerStore.getState().measurements.map((m) => m.id), ['m1']);
    assert.equal(focused(), 'Poly #1 · Length 10.000 m');
  });

  it('a distance row is a focus target named by its label and value', () => {
    useViewerStore.setState({ measurements: [D1, D2] });
    const container = mount();
    activate(button(container, 'Delete distance measurement 1'), ' ');
    assert.equal(focused(), '#1 7.000 m');
  });

  it('an angle row is a focus target too', () => {
    const picks = [
      { kind: 'points', point: mp(0, 0, 0) }, { kind: 'points', point: mp(1, 0, 0) }, { kind: 'points', point: mp(0, 1, 0) },
    ] as const;
    useViewerStore.setState({ measurements: [D1], angleMeasurements: [{ id: 'a1', kind: 'points', picks: [...picks] }] });
    const container = mount();
    activate(button(container, 'Delete distance measurement 1'), ' ');
    const name = focused();
    assert.match(name, /^Angle #1 \S/, `the angle row, by its label and value: ${name}`);
    assert.equal(name.endsWith('(not focusable)'), false, `a browser could focus it: ${name}`);
  });

  it('deleting the only row lands on the emptied list', () => {
    useViewerStore.setState({ polylineMeasurements: [PL1] });
    const container = mount();
    activate(button(container, 'Delete polyline measurement 1'), ' ');
    assert.match(container.textContent ?? '', /No measurements/, 'the list is empty');
    assert.equal(focused(), 'Measurements taken');
  });

  it('deleting the only row beside an open polyline lands on the list', () => {
    useViewerStore.setState({ polylineMeasurements: [PL1], activePolyline: OPEN_POLYLINE });
    const container = mount();
    activate(button(container, 'Delete polyline measurement 1'), ' ');
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 3, 'the open polyline stays open');
    assert.equal(focused(), 'Measurements taken');
  });

  it('a repeated Space on the row it landed on deletes nothing more', () => {
    useViewerStore.setState({ polylineMeasurements: [PL1, PL2] });
    const container = mount();
    activate(button(container, 'Delete polyline measurement 1'), ' ');
    const target = document.activeElement as HTMLElement;
    activate(target, ' ');
    press(target, ' ', { repeat: true });
    assert.deepEqual(useViewerStore.getState().polylineMeasurements.map((m) => m.id), ['pl2']);
    assert.equal(focused(), 'Poly #1 · Length 10.000 m');
  });

  it('a delete without focus in its row leaves focus where it was', () => {
    useViewerStore.setState({ polylineMeasurements: [PL1, PL2] });
    const container = mount();
    // Safari does not focus a button it clicks; and the canvas keeps focus
    // when a script or an assistive tool presses the button.
    const target = canvas(container);
    target.focus();
    act(() => { button(container, 'Delete polyline measurement 1').click(); });
    assert.deepEqual(useViewerStore.getState().polylineMeasurements.map((m) => m.id), ['pl2']);
    assert.equal(focused(), 'viewport-canvas');
  });

  it('a delete from the list itself keeps focus on the list', () => {
    useViewerStore.setState({ polylineMeasurements: [PL1, PL2] });
    const container = mount();
    const list = container.querySelector<HTMLElement>('fieldset[aria-label="Measurements taken"]')!;
    list.focus();
    act(() => { button(container, 'Delete polyline measurement 2').click(); });
    assert.equal(focused(), 'Measurements taken');
  });

  it('a row removed from the store while focused hands focus on too', () => {
    useViewerStore.setState({ polylineMeasurements: [PL1, PL2] });
    mount();
    activate(button(document.body, 'Delete polyline measurement 1'), ' ');
    // Focus is now on pl2's row; a removal from outside the list (undo, a load).
    act(() => { useViewerStore.getState().deletePolylineMeasurement('pl2'); });
    assert.equal(focused(), 'Measurements taken');
  });
});
