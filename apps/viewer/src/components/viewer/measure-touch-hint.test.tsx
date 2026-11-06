/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8879: on touch, the Measure hint names a tap, not a click, Shift or Esc.
 *
 * The hint follows the input the viewport saw last (`pointerInput`). That the
 * real touch and mouse paths set it is proven end to end in
 * `useTouchControls.one-pipeline.test.tsx`; this file pins the wording per
 * mode, the coarse-pointer seed and the ru strings. Assertions are on keys and
 * strings only, never on a DOM node.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { measureEn } from '@/i18n/catalogues/measure.en';
import { measureRu } from '@/i18n/locales/ru/measure';
import { measureDe } from '@/i18n/locales/de/measure';
import { initialPointerInput } from '@/store/slices/uiSlice.helpers';
import { measureHintKey, type MeasureHintState } from './tools/measure-modes/readouts.js';
import type { ActiveAngle, AngleKind, MeasurePoint } from '@/store/types';

const en = measureEn as Record<string, unknown>;
/** Words a touch user has no way to act on. */
const MOUSE_ONLY = /\b(click|dbl-click|shift|esc|enter)\b/i;

const mp = (x: number): MeasurePoint => ({ x, y: 0, z: 0, screenX: x, screenY: 0 });
const BASE: MeasureHintState = {
  measureMode: 'drag', angleKind: 'points', activeAngle: null, activePolyline: null,
  activeRadius: null, activeMeasurement: null, measurePointLast: null, pointerInput: 'mouse',
};

/** Every hint state a tap can act on; Polyline and Radius in progress finish from the list's ✓ (#8991). */
function tapStates(): Array<[string, Partial<MeasureHintState>]> {
  const states: Array<[string, Partial<MeasureHintState>]> = [
    ['drag start', { measureMode: 'drag' }],
    ['drag active', { measureMode: 'drag', activeMeasurement: { start: mp(0), current: mp(1), distance: 1 } }],
    ['point start', { measureMode: 'point' }],
    ['point active', { measureMode: 'point', measurePointLast: mp(1) }],
    ['polyline start', { measureMode: 'polyline' }],
    ['radius start', { measureMode: 'radius' }],
    ['polyline active', { measureMode: 'polyline', activePolyline: { points: [mp(0), mp(1)] } }],
    ['radius active', { measureMode: 'radius', activeRadius: { points: [mp(0), mp(1)] } }],
  ];
  const counts: Record<AngleKind, number> = { points: 3, edges: 4, faces: 2 };
  for (const kind of Object.keys(counts) as AngleKind[]) {
    for (let placed = 0; placed < counts[kind]; placed++) {
      const activeAngle = placed === 0 ? null : { kind, picks: Array.from({ length: placed }, () => ({ point: mp(placed) })) } as unknown as ActiveAngle;
      states.push([`angle ${kind} ${placed}`, { measureMode: 'angle', angleKind: kind, activeAngle }]);
    }
  }
  return states;
}

describe('every hint a tap acts on is tap-worded on touch (#8879)', () => {
  for (const [name, state] of tapStates()) {
    it(`${name}: touch is tap-worded, mouse keeps its wording`, () => {
      const mouseKey = measureHintKey({ ...BASE, ...state, pointerInput: 'mouse' });
      const touchKey = measureHintKey({ ...BASE, ...state, pointerInput: 'touch' });
      assert.notEqual(touchKey, mouseKey, 'touch has its own key');
      assert.doesNotMatch(String(en[touchKey]), MOUSE_ONLY, touchKey);
      assert.match(String(en[touchKey]), /\btap\b/i, touchKey);
    });
  }

  it('the Distance hint with a start pending names no Shift on touch, and does with a mouse', () => {
    const active = { ...BASE, activeMeasurement: { start: mp(0), current: mp(1), distance: 1 } };
    assert.doesNotMatch(String(en[measureHintKey({ ...active, pointerInput: 'touch' })]), /Shift/);
    assert.match(String(en[measureHintKey({ ...active, pointerInput: 'mouse' })]), /Shift/);
  });
});

describe('the input assumed before any is seen (#8879)', () => {
  const media = (coarse: boolean) => (query: string) => ({ matches: coarse && query === '(pointer: coarse)' });

  it('a coarse primary pointer (a phone or tablet) starts as touch', () => {
    assert.equal(initialPointerInput(media(true)), 'touch');
  });

  it('a fine primary pointer starts as mouse', () => {
    assert.equal(initialPointerInput(media(false)), 'mouse');
  });

  it('by default it asks the global matchMedia for a coarse pointer', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
    const asked: string[] = [];
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true, writable: true,
      value: (query: string) => { asked.push(query); return { matches: true }; },
    });
    try {
      assert.equal(initialPointerInput(), 'touch');
      assert.deepEqual(asked, ['(pointer: coarse)']);
    } finally {
      if (real) Object.defineProperty(globalThis, 'matchMedia', real);
      else delete (globalThis as { matchMedia?: unknown }).matchMedia;
    }
  });

  it('no matchMedia, or one that throws, starts as mouse', () => {
    assert.equal(initialPointerInput(undefined), 'mouse');
    assert.equal(initialPointerInput(() => { throw new Error('unsupported'); }), 'mouse');
  });
});

describe('ru and de carry the tap-worded hints (#8879)', () => {
  const touchKeys = Object.keys(measureEn).filter((k) => k.startsWith('measure.hint.') && k.endsWith('Touch'));
  for (const [locale, catalogue] of [['ru', measureRu], ['de', measureDe]] as const) {
    it(`every touch hint key has a ${locale} string, with no Shift, Esc or Enter`, () => {
      assert.ok(touchKeys.includes('measure.hint.dragStartTouch') && touchKeys.includes('measure.hint.dragActiveTouch'), touchKeys.join(', '));
      const strings = catalogue as Record<string, unknown>;
      assert.deepEqual(touchKeys.filter((k) => typeof strings[k] !== 'string' || strings[k] === ''), [], `${locale} keys missing`);
      assert.deepEqual(touchKeys.filter((k) => /Shift|Umschalt|Esc|Enter/.test(String(strings[k]))), [], `${locale} touch hints must not name keys`);
    });
  }
});
