/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dimensions in the per-model v1 markup entry: an optional field, so entries
 * saved before dimensions existed load unchanged, and a malformed dimension
 * is dropped without costing the rest of the entry.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadDrawing2DEntry,
  saveDrawing2DEntry,
  clearAllDrawing2DEntries,
  defaultMarkupPatch,
  keyFor,
} from './drawing2DSlice.persistence.js';
import { getDefaultDrawing2DState } from './drawing2DSlice.js';
import type { Dimension2D } from './drawing2DDimensions.js';

const DEFAULTS = getDefaultDrawing2DState().drawing2DDisplayOptions;

function installStubStorage(): void {
  const data = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
  } as Storage;
}

const dimension: Dimension2D = {
  id: 'd1', a: { x: 0, y: 0 }, b: { x: 4.2624, y: 0 }, offset: -0.6, orientation: 'horizontal', text: '<> clear',
  refs: { a: { globalId: '2O2Fr$t4X7Zf8NOew3FLOH', ifcType: 'IfcWall' } },
  plane: { axis: 'down', position: 42, flipped: false },
};
const measure = { id: 'm1', start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 };

/** An entry exactly as a viewer from before dimensions wrote it: no `dimensions2D` key at all. */
const oldEntry = () => ({
  measure2DResults: [measure], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
  drawing2DDisplayOptions: DEFAULTS, sectionConfig: null, savedAt: 1_700_000_000_000,
});

describe('dimension persistence', () => {
  const realWarn = console.warn;
  beforeEach(() => {
    console.warn = () => { /* malformed-entry warnings are expected here */ };
    installStubStorage();
    clearAllDrawing2DEntries();
  });
  afterEach(() => { console.warn = realWarn; });

  it('round-trips dimensions with every optional field', () => {
    saveDrawing2DEntry('hash-a', { ...oldEntry(), dimensions2D: [dimension] });
    const restored = loadDrawing2DEntry('hash-a', DEFAULTS);
    assert.ok(restored, 'the entry loads');
    assert.deepEqual(restored.dimensions2D, [dimension]);
    assert.deepEqual(restored.measure2DResults.map((m) => m.id), ['m1']);
  });

  it('loads an old entry without the field unchanged, with no dimensions', () => {
    localStorage.setItem(keyFor('hash-old'), JSON.stringify(oldEntry()));
    const restored = loadDrawing2DEntry('hash-old', DEFAULTS);
    assert.ok(restored, 'an entry saved before dimensions existed is still valid');
    assert.deepEqual(restored.measure2DResults.map((m) => m.id), ['m1'], 'its markup is all there');
    assert.deepEqual(restored.dimensions2D, []);
  });

  it('filters a malformed dimension and keeps the valid ones and the rest of the entry', () => {
    localStorage.setItem(keyFor('hash-bad'), JSON.stringify({
      ...oldEntry(),
      dimensions2D: [dimension, { ...dimension, id: 'd2', offset: 'far' }, { id: 'd3' }, null, { ...dimension, id: 'd4', orientation: 'radial' }],
    }));
    const restored = loadDrawing2DEntry('hash-bad', DEFAULTS);
    assert.ok(restored, 'the entry still loads');
    assert.deepEqual(restored.dimensions2D?.map((d) => d.id), ['d1']);
    assert.deepEqual(restored.measure2DResults.map((m) => m.id), ['m1']);
  });

  it('a dimensions2D field that is not a list loads as none, without rejecting the entry', () => {
    localStorage.setItem(keyFor('hash-odd'), JSON.stringify({ ...oldEntry(), dimensions2D: { d1: dimension } }));
    const restored = loadDrawing2DEntry('hash-odd', DEFAULTS);
    assert.ok(restored, 'the entry loads');
    assert.deepEqual(restored.dimensions2D, []);
  });

  it('the default markup patch clears dimensions', () => {
    assert.deepEqual(defaultMarkupPatch().dimensions2D, []);
  });
});
