/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `duplicateChart` (#6474): a deep copy under a fresh id, right after the original. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { modelOverviewDashboard, duplicateChart } from './presets.js';

describe('duplicateChart (#6474)', () => {
  it('inserts a deep copy with a new id and title right after the original', () => {
    const dashboard = modelOverviewDashboard();
    const original = dashboard.charts[0];
    const result = duplicateChart(dashboard, original.id, 'Elements by type (copy)')!;
    assert.deepEqual(result.dashboard.charts.map((c) => c.id), [original.id, result.chart.id, dashboard.charts[1].id, dashboard.charts[2].id]);
    assert.notEqual(result.chart.id, original.id);
    assert.equal(result.chart.title, 'Elements by type (copy)');
    assert.deepEqual({ ...result.chart, id: '', title: '' }, { ...original, id: '', title: '' });
    assert.notEqual(result.chart, original);
    assert.equal(dashboard.charts.length, 3, 'input is not mutated');
  });

  it('does not share nested definition state with the original', () => {
    const dashboard = modelOverviewDashboard();
    dashboard.charts[0] = { ...dashboard.charts[0], filter: { selector: 'IfcWall' } };
    const { chart } = duplicateChart(dashboard, dashboard.charts[0].id, 'copy')!;
    chart.filter!.selector = 'IfcDoor';
    assert.equal(dashboard.charts[0].filter?.selector, 'IfcWall');
  });

  it('lays the copy out below everything, at the original size', () => {
    const dashboard = modelOverviewDashboard();
    const result = duplicateChart(dashboard, dashboard.charts[0].id, 'c')!;
    const item = result.dashboard.layout.at(-1)!;
    assert.equal(item.chartId, result.chart.id);
    assert.equal(item.y, 8);
    assert.deepEqual([item.w, item.h], [6, 4]);
    assert.equal(result.dashboard.layout.length, dashboard.layout.length + 1);
  });

  it('returns null for an unknown chart', () => {
    assert.equal(duplicateChart(modelOverviewDashboard(), 'nope', 'c'), null);
  });
});
