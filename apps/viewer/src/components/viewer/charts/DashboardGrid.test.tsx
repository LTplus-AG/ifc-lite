/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The dashboard grid and the dashboard file (#3944): the spec's layout is
 * the source of truth the grid reads and writes back, a card without a
 * layout row is appended below the others, an import re-identifies charts
 * and keeps their positions, and an invalid file is refused with its path.
 */
import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateDashboardSpec, type DashboardSpec } from '@ifc-lite/charts';
import { render, cleanup } from '@/test/render.js';
import { installLayout } from '@/test/dom-layout.js';
import { DashboardGrid, fromGridLayout, toGridLayout } from './DashboardGrid.js';
import { parseDashboardFile } from '@/lib/charts/persistence.js';
import { coordinationDashboard } from '@/lib/charts/presets.js';

installLayout();

describe('DashboardGrid layout mapping', () => {
  afterEach(() => cleanup());

  it('maps the spec layout to grid items and appends a chart without a row below the others', () => {
    const items = toGridLayout([{ chartId: 'a', x: 0, y: 0, w: 6, h: 4 }, { chartId: 'b', x: 6, y: 0, w: 6, h: 4 }], ['a', 'b', 'c']);
    assert.deepEqual(items.map((i) => [i.i, i.x, i.y, i.w, i.h]), [['a', 0, 0, 6, 4], ['b', 6, 0, 6, 4], ['c', 0, 4, 6, 4]]);
    assert.deepEqual(fromGridLayout(items), [
      { chartId: 'a', x: 0, y: 0, w: 6, h: 4 }, { chartId: 'b', x: 6, y: 0, w: 6, h: 4 }, { chartId: 'c', x: 0, y: 4, w: 6, h: 4 },
    ]);
  });

  it('stacks the cards one per row in reading order on a narrow grid and clamps sizes below the minimum (review finding)', () => {
    const folded = toGridLayout([{ chartId: 'a', x: 6, y: 0, w: 6, h: 4 }, { chartId: 'b', x: 0, y: 0, w: 6, h: 4 }, { chartId: 'c', x: 0, y: 4, w: 1, h: 1 }], ['a', 'b', 'c'], 6);
    assert.deepEqual(folded.map((i) => [i.i, i.x, i.y, i.w, i.h]), [['b', 0, 0, 6, 4], ['a', 0, 4, 6, 4], ['c', 0, 8, 6, 3]]);
    // At full width the saved positions are kept, only the undersized card is clamped.
    const full = toGridLayout([{ chartId: 'c', x: 0, y: 4, w: 1, h: 1 }], ['c']);
    assert.deepEqual(full.map((i) => [i.x, i.y, i.w, i.h]), [[0, 4, 3, 3]]);
  });

  it('renders one grid item per id and does not write a layout back for a layout that did not change', () => {
    const layout = [{ chartId: 'a', x: 0, y: 0, w: 6, h: 4 }, { chartId: 'b', x: 6, y: 0, w: 6, h: 4 }];
    const writes: unknown[] = [];
    const ui = render(
      <DashboardGrid layout={layout} ids={['a', 'b']} renderItem={(id) => <span data-card={id}>{id}</span>} onLayoutChange={(l) => writes.push(l)} />,
    );
    assert.equal(ui.querySelectorAll('[data-grid-item]').length, 2);
    assert.equal(ui.querySelector('[data-card="b"]')?.textContent, 'b');
    assert.deepEqual(writes, [], 'mounting an already-compact layout is not a save');
  });
});

describe('dashboard file', () => {
  it('re-identifies an imported dashboard and its charts while keeping the layout positions', () => {
    const original = coordinationDashboard();
    const imported = parseDashboardFile(JSON.stringify(original));
    assert.notEqual(imported.id, original.id);
    assert.equal(imported.charts.length, original.charts.length);
    imported.charts.forEach((c, i) => {
      assert.notEqual(c.id, original.charts[i].id);
      assert.equal(c.title, original.charts[i].title);
    });
    imported.layout.forEach((l, i) => {
      assert.equal(l.chartId, imported.charts[i].id, 'layout follows the new chart ids');
      assert.deepEqual([l.x, l.y, l.w, l.h], [original.layout[i].x, original.layout[i].y, original.layout[i].w, original.layout[i].h]);
    });
    assert.deepEqual(validateDashboardSpec(imported), []);
    // Importing the same file twice yields two distinct dashboards.
    assert.notEqual(parseDashboardFile(JSON.stringify(original)).id, imported.id);
  });

  it('refuses a file that is not a dashboard, naming the first problems', () => {
    const broken = { ...coordinationDashboard(), version: 2, charts: 'nope' } as unknown as DashboardSpec;
    assert.throws(() => parseDashboardFile(JSON.stringify(broken)), /Not a dashboard file: .*version.*expected version 1/);
    assert.throws(() => parseDashboardFile('{'), SyntaxError);
  });
});
