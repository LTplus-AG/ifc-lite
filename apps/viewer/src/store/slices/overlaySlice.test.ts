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

describe('overlaySlice — composeLayers pure function', () => {
  it('returns empty maps for empty input', () => {
    const { hiddenIds, colorOverrides } = composeLayers(new Map());
    assert.strictEqual(hiddenIds.size, 0);
    assert.strictEqual(colorOverrides.size, 0);
  });

  it('unions hiddenIds across every layer (no priority weighting)', () => {
    const layers = new Map<string, OverlayLayer>([
      ['a', mkLayer('a', 100, { hide: [1, 2] })],
      ['b', mkLayer('b', 200, { hide: [2, 3] })],
    ]);
    const { hiddenIds } = composeLayers(layers);
    assert.deepStrictEqual(Array.from(hiddenIds).sort((a, b) => a - b), [1, 2, 3]);
  });

  it('higher-priority layer wins on colour collisions', () => {
    // Layer 'a' @ priority 100 paints id=5 red.
    // Layer 'b' @ priority 200 paints id=5 green.
    // Composite must show green (b's priority is higher).
    const layers = new Map<string, OverlayLayer>([
      ['a', mkLayer('a', 100, { colour: [[5, RED]] })],
      ['b', mkLayer('b', 200, { colour: [[5, GREEN]] })],
    ]);
    const { colorOverrides } = composeLayers(layers);
    assert.deepStrictEqual(colorOverrides.get(5), GREEN);
  });

  it('non-colliding colours from different layers all survive', () => {
    const layers = new Map<string, OverlayLayer>([
      ['a', mkLayer('a', 100, { colour: [[1, RED], [2, RED]] })],
      ['b', mkLayer('b', 200, { colour: [[3, GREEN]] })],
    ]);
    const { colorOverrides } = composeLayers(layers);
    assert.strictEqual(colorOverrides.size, 3);
    assert.deepStrictEqual(colorOverrides.get(1), RED);
    assert.deepStrictEqual(colorOverrides.get(2), RED);
    assert.deepStrictEqual(colorOverrides.get(3), GREEN);
  });

  it('null hiddenIds / colorOverrides fields are ignored (no contribution)', () => {
    const layers = new Map<string, OverlayLayer>([
      ['a', mkLayer('a', 100, { hide: [1, 2] })],
      ['b', { id: 'b', priority: 200, hiddenIds: null, colorOverrides: null }],
    ]);
    const { hiddenIds, colorOverrides } = composeLayers(layers);
    assert.deepStrictEqual(Array.from(hiddenIds).sort((a, b) => a - b), [1, 2]);
    assert.strictEqual(colorOverrides.size, 0);
  });

  it('is deterministic regardless of insertion order when priorities differ', () => {
    // Whether we insert 'a' before 'b' or after, result must be identical.
    const abOrder = composeLayers(new Map<string, OverlayLayer>([
      ['a', mkLayer('a', 100, { colour: [[1, RED]] })],
      ['b', mkLayer('b', 200, { colour: [[1, BLUE]] })],
    ]));
    const baOrder = composeLayers(new Map<string, OverlayLayer>([
      ['b', mkLayer('b', 200, { colour: [[1, BLUE]] })],
      ['a', mkLayer('a', 100, { colour: [[1, RED]] })],
    ]));
    assert.deepStrictEqual(abOrder.colorOverrides.get(1), baOrder.colorOverrides.get(1));
    assert.deepStrictEqual(abOrder.colorOverrides.get(1), BLUE);
  });
});

describe('overlaySlice — store wiring', () => {
  function bootOverlayStore() {
    return create<OverlaySlice>()((...args) => ({
      ...createOverlaySlice(...args),
    }));
  }

  it('registerOverlayLayer upserts — same id twice replaces', () => {
    const store = bootOverlayStore();
    store.getState().registerOverlayLayer(mkLayer('animation', 100, { hide: [1] }));
    assert.strictEqual(store.getState().overlayLayers.size, 1);
    store.getState().registerOverlayLayer(mkLayer('animation', 100, { hide: [2] }));
    assert.strictEqual(store.getState().overlayLayers.size, 1);
    const layer = store.getState().overlayLayers.get('animation')!;
    assert.deepStrictEqual(Array.from(layer.hiddenIds!), [2]);
  });

  it('removeOverlayLayer drops by id; idempotent on unknown id', () => {
    const store = bootOverlayStore();
    store.getState().registerOverlayLayer(mkLayer('animation', 100, { hide: [1] }));
    store.getState().registerOverlayLayer(mkLayer('gantt', 200, { colour: [[5, RED]] }));
    store.getState().removeOverlayLayer('animation');
    assert.strictEqual(store.getState().overlayLayers.size, 1);
    assert.ok(store.getState().overlayLayers.has('gantt'));
    // Idempotent.
    store.getState().removeOverlayLayer('animation');
    store.getState().removeOverlayLayer('never-registered');
    assert.strictEqual(store.getState().overlayLayers.size, 1);
  });

  it('Map identity changes on every upsert so shallow-compare subscribers fire', () => {
    // Zustand's default equality is Object.is — Maps compare by identity.
    // If we mutated in place, subscribers using shallow compares would
    // miss updates.
    const store = bootOverlayStore();
    const ref1 = store.getState().overlayLayers;
    store.getState().registerOverlayLayer(mkLayer('animation', 100, { hide: [1] }));
    const ref2 = store.getState().overlayLayers;
    assert.notStrictEqual(ref1, ref2, 'register must produce a new Map');
    store.getState().removeOverlayLayer('animation');
    const ref3 = store.getState().overlayLayers;
    assert.notStrictEqual(ref2, ref3, 'remove must produce a new Map');
  });

  it('computeCompositeOverlay reads through the registered set', () => {
    const store = bootOverlayStore();
    store.getState().registerOverlayLayer(mkLayer('lens', 50, { colour: [[10, BLUE]] }));
    store.getState().registerOverlayLayer(mkLayer('animation', 100, {
      hide: [1, 2],
      colour: [[10, GREEN]], // overrides lens's blue
    }));
    const { hiddenIds, colorOverrides } = store.getState().computeCompositeOverlay();
    assert.deepStrictEqual(Array.from(hiddenIds).sort((a, b) => a - b), [1, 2]);
    assert.deepStrictEqual(colorOverrides.get(10), GREEN);
  });
});
