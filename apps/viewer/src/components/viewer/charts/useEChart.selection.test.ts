/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectionFromEChartEvent } from './useEChart.js';

describe('chart click replacement selection (#4832)', () => {
  it('uses the clicked bucket instead of ECharts cumulative selected state', () => {
    assert.deepEqual(selectionFromEChartEvent({
      fromAction: 'toggleSelected',
      fromActionPayload: { seriesIndex: 0, dataIndex: 1 },
      selected: [{ seriesIndex: 0, dataIndex: [0, 1] }],
    }), { items: [{ seriesIndex: 0, dataIndex: 1 }] });
  });

  it('clears selection when the current bucket is unselected', () => {
    assert.deepEqual(selectionFromEChartEvent({
      fromAction: 'toggleSelected',
      fromActionPayload: { seriesIndex: 0, dataIndex: 1 },
      selected: [],
    }), { items: [] });
  });

  it('retains cumulative fallback semantics for non-click actions without a payload', () => {
    assert.deepEqual(selectionFromEChartEvent({
      selected: [
        { seriesIndex: 0, dataIndex: [2] },
        { seriesIndex: 1, dataIndex: [3] },
      ],
    }), { items: [
      { seriesIndex: 0, dataIndex: 2 },
      { seriesIndex: 1, dataIndex: 3 },
    ] });
  });
});
