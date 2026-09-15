/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OverlayLayer, RGBA } from '@/store/slices/overlaySlice.js';
import { chartAwareRendererSelection, effectiveChartPaint } from './renderer-selection.js';

describe('chart-aware renderer selection (#4832)', () => {
  it('keeps logical chart ids out of the blue renderer highlight while chart colour is active', () => {
    const result = chartAwareRendererSelection(12, new Set([11, 12]), new Set([11, 12]), new Map([[11, true], [12, true]]));
    assert.equal(result.selectedId, null);
    assert.deepEqual([...result.selectedIds], []);
  });

  it('retains blue selection where a higher-priority animation wins the composite paint', () => {
    const chartColor: RGBA = [1, 0, 0, 1];
    const animationColor: RGBA = [0, 1, 0, 1];
    const layers = new Map<string, OverlayLayer>([
      ['charts', { id: 'charts', priority: 75, hiddenIds: null, colorOverrides: new Map([[11, chartColor], [12, chartColor]]) }],
      ['animation', { id: 'animation', priority: 100, hiddenIds: null, colorOverrides: new Map([[12, animationColor]]) }],
    ]);
    const effective = effectiveChartPaint(layers, new Map([[11, chartColor], [12, animationColor]]));
    assert.deepEqual([...(effective?.keys() ?? [])], [11]);
    const result = chartAwareRendererSelection(12, new Set([11, 12]), new Set([11, 12]), effective);
    assert.deepEqual([...result.selectedIds], [12]);
    assert.equal(result.selectedId, 12);
  });

  it('suppresses only chart ids that still have live paint', () => {
    const active = chartAwareRendererSelection(99, new Set([11, 12, 99]), new Set([11, 12]), new Map([[11, true]]));
    assert.equal(active.selectedId, 99);
    assert.deepEqual([...active.selectedIds], [12, 99]);
  });

  it('returns the original set after chart paint teardown and caches active filtering by identity', () => {
    const selected = new Set([11, 12]);
    const slice = new Set([11, 12]);
    const paint = new Map([[11, true], [12, true]]);
    const first = chartAwareRendererSelection(12, selected, slice, paint);
    const repeated = chartAwareRendererSelection(12, selected, slice, paint);
    assert.equal(repeated, first);

    const inactive = chartAwareRendererSelection(12, selected, slice, null);
    assert.equal(inactive.selectedId, 12);
    assert.equal(inactive.selectedIds, selected);
  });

  it('restores blue selection when another owner clears the actual scene paint', () => {
    const color: RGBA = [1, 0, 0, 1];
    const layers = new Map<string, OverlayLayer>([
      ['charts', { id: 'charts', priority: 75, hiddenIds: null, colorOverrides: new Map([[11, color]]) }],
    ]);
    const selected = new Set([11]);
    const painted = effectiveChartPaint(layers, new Map([[11, color]]));
    assert.deepEqual([...chartAwareRendererSelection(11, selected, selected, painted).selectedIds], []);

    const cleared = effectiveChartPaint(layers, null);
    const restored = chartAwareRendererSelection(11, selected, selected, cleared);
    assert.equal(restored.selectedId, 11);
    assert.equal(restored.selectedIds, selected);
  });
});
