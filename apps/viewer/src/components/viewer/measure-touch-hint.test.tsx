/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8879: on touch, the Measure hint names a tap, not a click, Shift or Esc.
 *
 * The hint follows the input the Measure gesture saw last: a tap (the touch
 * path, `handleMeasureTap`) makes it tap-worded, a mouse move or press on the
 * canvas (the mouse controls) makes it click-worded again. A hybrid device
 * (a touch laptop with a mouse) shows the wording for whichever was used last.
 * Every assertion is on strings or keys, never on a DOM node.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { measureEn } from '@/i18n/catalogues/measure.en';
import { measureRu } from '@/i18n/locales/ru/measure';
import { cleanupMouseControls, mountMouseControls, mousePointer } from '@/test/mouse-controls-fixture.js';
import type { UseMouseControlsParams } from './useMouseControls.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { handleMeasureTap } from './touchRouting.js';
import { measureHintKey } from './tools/measure-modes/readouts.js';
import type { ActiveAngle, AngleKind, MeasureMode, MeasurePoint } from '@/store/types';

const s = () => useViewerStore.getState();
const initial = useViewerStore.getState();

/** The hint line's English text for the store as it stands. */
const hint = (): string => {
  const key = measureHintKey(s() as unknown as Parameters<typeof measureHintKey>[0]);
  return String((measureEn as Record<string, unknown>)[key]);
};

/** Words a touch user has no way to act on. */
const MOUSE_ONLY = /\b(click|clicks|dbl-click|shift|esc|enter)\b/i;

/** Canvas x/100 is world x and (300 - y)/100 is world y. */
function raycastSceneMagnetic(x: number, y: number) {
  const edgeLock = { shouldRelease: false, shouldLock: false, edge: null };
  return { intersection: { point: { x: x / 100, y: (300 - y) / 100, z: 0 } }, snapTarget: null, edgeLock };
}

const storeBound: Partial<UseMouseControlsParams> = {
  activeToolRef: { current: 'measure' },
  activeMeasurementRef: { get current() { return s().activeMeasurement; }, set current(_v) { /* store-owned */ } },
  measurementConstraintEdgeRef: { get current() { return s().measurementConstraintEdge; }, set current(_v) { /* store-owned */ } },
  startMeasurement: (p) => s().startMeasurement(p),
  updateMeasurement: (p) => s().updateMeasurement(p),
  finalizeMeasurement: () => s().finalizeMeasurement(),
  setMeasurementConstraintEdge: (edge) => s().setMeasurementConstraintEdge(edge),
  updateConstraintActiveAxis: (axis) => s().updateConstraintActiveAxis(axis),
  edgeLockStateRef: { get current() { return s().edgeLockState; }, set current(_v) { /* store-owned */ } },
  setEdgeLock: (edge, id, t) => s().setEdgeLock(edge, id, t),
  updateEdgeLockPosition: (t, corner, valence) => s().updateEdgeLockPosition(t, corner, valence),
  clearEdgeLock: () => s().clearEdgeLock(),
  incrementEdgeLockStrength: () => s().incrementEdgeLockStrength(),
};

let frames: FrameRequestCallback[] = [];
const realRaf = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;
const flushFrames = (): void => {
  const run = frames; frames = [];
  act(() => { for (const f of run) f(0); });
};

function mount() {
  const rig = mountMouseControls(storeBound);
  Object.assign(rig.params.rendererRef.current!, { raycastSceneMagnetic });
  const ctx = {
    ...rig.params, canvas: rig.canvas, renderer: rig.params.rendererRef.current,
    camera: rig.params.rendererRef.current!.getCamera(), mouseState: rig.params.mouseStateRef.current,
  } as unknown as MouseHandlerContext;
  return { canvas: rig.canvas, tap: (x: number, y: number) => act(() => handleMeasureTap(ctx, x, y)) };
}

const fire = (canvas: HTMLCanvasElement, type: string, x: number, y: number) =>
  act(() => { canvas.dispatchEvent(mousePointer(type, 0, x, y, { pointerType: 'mouse' })); });
const mouseMove = (canvas: HTMLCanvasElement, x: number, y: number) => { fire(canvas, 'pointermove', x, y); flushFrames(); };
const mouseClick = (canvas: HTMLCanvasElement, x: number, y: number) => { fire(canvas, 'pointerdown', x, y); fire(canvas, 'pointerup', x, y); };

beforeEach(() => {
  useViewerStore.setState(initial, true);
  s().setActiveTool('measure');
  s().setMeasureMode('drag');
  frames = [];
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  globalThis.cancelAnimationFrame = () => { frames = []; };
});

afterEach(() => {
  cleanupMouseControls();
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
  useViewerStore.setState(initial, true);
});

describe('the Distance hint follows the last input (#8879)', () => {
  it('a touch tap leaves a hint with no Shift, Esc or click', () => {
    const { tap } = mount();
    tap(200, 300);
    assert.ok(s().activeMeasurement, 'the tap set the start');
    assert.doesNotMatch(hint(), MOUSE_ONLY, 'the pending-end hint after a tap');
    assert.match(hint(), /tap/i);
  });

  it('a mouse move after a tap switches the hint back to click wording with Shift', () => {
    const { canvas, tap } = mount();
    tap(200, 300);
    mouseMove(canvas, 400, 300);
    assert.match(hint(), /Shift/, 'the mouse user is offered the axis lock again');
    assert.match(hint(), /click/i);
  });

  it('a mouse click with no move after a tap switches the hint back', () => {
    const { canvas, tap } = mount();
    tap(200, 300);
    tap(500, 300);
    assert.equal(s().measurements.length, 1, 'two taps measured');
    assert.doesNotMatch(hint(), MOUSE_ONLY, 'the start hint after a tap');
    mouseClick(canvas, 200, 300);
    assert.ok(s().activeMeasurement, 'the click set a start');
    assert.match(hint(), /Shift/);
  });

  it('on a hybrid device the hint follows whichever input was used last', () => {
    const { canvas, tap } = mount();
    mouseMove(canvas, 100, 300);
    assert.match(hint(), /click/i, 'mouse first');
    tap(200, 300);
    assert.doesNotMatch(hint(), MOUSE_ONLY, 'then a tap');
    mouseMove(canvas, 300, 300);
    assert.match(hint(), /Shift/, 'then the mouse again');
    tap(400, 300);
    assert.equal(s().measurements.length, 1, 'a tap may finish a mouse-started measurement');
    assert.doesNotMatch(hint(), MOUSE_ONLY, 'then a tap again');
  });

  it('a mouse move before any tap keeps the click wording (the default)', () => {
    assert.match(hint(), /click/i, 'no input yet reads as a mouse');
  });
});

const mp = (x: number): MeasurePoint => ({ x, y: 0, z: 0, screenX: x, screenY: 0 });

/** Every hint state a tap can reach, outside Polyline/Radius in progress (#8879 follow-up). */
function touchStates(): Array<[string, Record<string, unknown>]> {
  const states: Array<[string, Record<string, unknown>]> = [
    ['drag start', { measureMode: 'drag' as MeasureMode }],
    ['drag active', { measureMode: 'drag' as MeasureMode, activeMeasurement: { start: mp(0), current: mp(1), distance: 1 } }],
    ['point start', { measureMode: 'point' as MeasureMode }],
    ['point active', { measureMode: 'point' as MeasureMode, measurePointLast: mp(1) }],
    ['polyline start', { measureMode: 'polyline' as MeasureMode }],
    ['radius start', { measureMode: 'radius' as MeasureMode }],
  ];
  const counts: Record<AngleKind, number> = { points: 3, edges: 4, faces: 2 };
  for (const kind of Object.keys(counts) as AngleKind[]) {
    for (let placed = 0; placed < counts[kind]; placed++) {
      const activeAngle = placed === 0 ? null : { kind, picks: Array.from({ length: placed }, () => ({ point: mp(placed) })) } as unknown as ActiveAngle;
      states.push([`angle ${kind} ${placed}`, { measureMode: 'angle' as MeasureMode, angleKind: kind, activeAngle }]);
    }
  }
  return states;
}

describe('every mode a tap finishes has tap wording (#8879)', () => {
  for (const [name, state] of touchStates()) {
    it(`${name}: touch is tap-worded, mouse keeps its wording`, () => {
      act(() => useViewerStore.setState({ ...state, measureInput: 'mouse' } as never));
      const mouseKey = measureHintKey(s() as unknown as Parameters<typeof measureHintKey>[0]);
      act(() => useViewerStore.setState({ measureInput: 'touch' } as never));
      const touchKey = measureHintKey(s() as unknown as Parameters<typeof measureHintKey>[0]);
      assert.notEqual(touchKey, mouseKey, 'touch has its own key');
      assert.doesNotMatch(String((measureEn as Record<string, unknown>)[touchKey]), MOUSE_ONLY, touchKey);
      assert.match(String((measureEn as Record<string, unknown>)[touchKey]), /\btap\b/i, touchKey);
    });
  }
});

describe('ru carries the tap-worded hints (#8879)', () => {
  it('every touch hint key has a ru string, with no Shift or Esc', () => {
    const touchKeys = Object.keys(measureEn).filter((k) => k.startsWith('measure.hint.') && k.endsWith('Touch'));
    assert.ok(touchKeys.length >= 2, `touch hint keys in en: ${touchKeys.join(', ')}`);
    assert.ok(touchKeys.includes('measure.hint.dragStartTouch') && touchKeys.includes('measure.hint.dragActiveTouch'), touchKeys.join(', '));
    const ru = measureRu as Record<string, unknown>;
    const missing = touchKeys.filter((k) => typeof ru[k] !== 'string' || ru[k] === '');
    assert.deepEqual(missing, [], 'ru keys missing');
    const mouseWords = touchKeys.filter((k) => /Shift|Esc|Enter/.test(String(ru[k])));
    assert.deepEqual(mouseWords, [], 'ru touch hints must not name keys');
  });
});
