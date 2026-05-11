/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { create } from 'zustand';
import {
  createOverlaySlice,
  composeLayers,
  type OverlaySlice,
  type OverlayLayer,
  type RGBA,
} from './overlaySlice.js';

const RED: RGBA = [1, 0, 0, 1];
const GREEN: RGBA = [0, 1, 0, 1];
const BLUE: RGBA = [0, 0, 1, 1];

function mkLayer(id: string, priority: number, opts: {
  hide?: Iterable<number>;
  colour?: Iterable<[number, RGBA]>;
} = {}): OverlayLayer {
  return {
    id,
    priority,
    hiddenIds: opts.hide ? new Set(opts.hide) : null,
    colorOverrides: opts.colour ? new Map(opts.colour) : null,
  };
}

describe('overlaySlice — composition', () => {
  it('unions hiddenIds; higher-priority layer wins on colour collisions', () => {
    // The two non-trivial algorithmic properties of the compositor in one
    // test: union for visibility, priority-ordered overwrite for colour.
    const layers = new Map<string, OverlayLayer>([
      ['lens',      mkLayer('lens',      50,  { hide: [1],       colour: [[5, RED]] })],
      ['animation', mkLayer('animation', 100, { hide: [2, 3],    colour: [[5, GREEN]] })],
    ]);
    const { hiddenIds, colorOverrides } = composeLayers(layers);
    assert.deepStrictEqual(Array.from(hiddenIds).sort((a, b) => a - b), [1, 2, 3]);
    assert.deepStrictEqual(colorOverrides.get(5), GREEN);
  });

  it('result is independent of Map insertion order', () => {
    // Property test — we sort by priority internally, so whichever order
    // the caller inserts layers the answer must match.
    const ab = composeLayers(new Map<string, OverlayLayer>([
      ['a', mkLayer('a', 100, { colour: [[1, RED]] })],
      ['b', mkLayer('b', 200, { colour: [[1, BLUE]] })],
    ]));
    const ba = composeLayers(new Map<string, OverlayLayer>([
      ['b', mkLayer('b', 200, { colour: [[1, BLUE]] })],
      ['a', mkLayer('a', 100, { colour: [[1, RED]] })],
    ]));
    assert.deepStrictEqual(ab.colorOverrides.get(1), ba.colorOverrides.get(1));
    assert.deepStrictEqual(ab.colorOverrides.get(1), BLUE);
  });
});

describe('overlaySlice — store wiring', () => {
  function bootOverlayStore() {
    return create<OverlaySlice>()((...args) => ({
      ...createOverlaySlice(...args),
    }));
  }

  it('registerOverlayLayer upserts; removeOverlayLayer is idempotent', () => {
    const store = bootOverlayStore();
    store.getState().registerOverlayLayer(mkLayer('animation', 100, { hide: [1] }));
    store.getState().registerOverlayLayer(mkLayer('animation', 100, { hide: [2] }));
    assert.strictEqual(store.getState().overlayLayers.size, 1);
    assert.deepStrictEqual(Array.from(store.getState().overlayLayers.get('animation')!.hiddenIds!), [2]);
    store.getState().removeOverlayLayer('animation');
    store.getState().removeOverlayLayer('animation'); // idempotent
    store.getState().removeOverlayLayer('never-registered');
    assert.strictEqual(store.getState().overlayLayers.size, 0);
  });

  it('Map identity changes on every mutation so shallow-compare subscribers fire', () => {
    // Zustand default equality is Object.is — Maps compare by identity.
    // If we mutated in place, Gantt / renderer subscribers would miss
    // layer updates and the viewport would stop refreshing.
    const store = bootOverlayStore();
    const ref1 = store.getState().overlayLayers;
    store.getState().registerOverlayLayer(mkLayer('animation', 100, { hide: [1] }));
    const ref2 = store.getState().overlayLayers;
    store.getState().removeOverlayLayer('animation');
    const ref3 = store.getState().overlayLayers;
    assert.notStrictEqual(ref1, ref2);
    assert.notStrictEqual(ref2, ref3);
  });
});
