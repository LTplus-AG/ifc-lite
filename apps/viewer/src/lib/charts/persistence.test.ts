/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dashboard persistence migrates a saved version-1 entry to version 2
 * (#4946) before validating it, both for the localStorage list and for an
 * imported `.ifclite-dashboard.json` file — a stored dashboard from before
 * this change must still load, with its `list` scope (if any) folded to
 * `all` since the resolver it needed no longer exists.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { DashboardSpec } from '@ifc-lite/charts';
import { loadDashboards, parseDashboardFile, saveDashboards } from './persistence.js';

class MemoryStorage {
  readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

const g = globalThis as { localStorage?: unknown };
const KEY = 'ifc-lite-dashboards';

const v1Dashboard = {
  version: 1,
  id: 'd1',
  name: 'Overview',
  scope: { kind: 'all' },
  charts: [{ id: 'c1', title: 'Elements by type', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } }],
  layout: [{ chartId: 'c1', x: 0, y: 0, w: 6, h: 4 }],
};

describe('chart dashboard persistence migrates version 1 -> 2 before validating (#4946)', () => {
  let ls: MemoryStorage;
  const original = g.localStorage;

  beforeEach(() => {
    ls = new MemoryStorage();
    g.localStorage = ls;
  });
  after(() => { g.localStorage = original; });

  it('loadDashboards migrates a saved version-1 entry and keeps it (not dropped as invalid)', () => {
    ls.setItem(KEY, JSON.stringify([v1Dashboard]));
    const loaded = loadDashboards();
    assert.equal(loaded.length, 1, 'a version-1 entry is migrated, not dropped');
    assert.equal(loaded[0].version, 2);
    assert.deepEqual(loaded[0].scope, { kind: 'all' });
  });

  it('loadDashboards folds a saved version-1 "list" scope to "all"', () => {
    ls.setItem(KEY, JSON.stringify([{ ...v1Dashboard, scope: { kind: 'list', listId: 'saved-1' } }]));
    const loaded = loadDashboards();
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0].scope, { kind: 'all' });
  });

  it('a dashboard round-trips through save/load at version 2 unchanged', () => {
    const v2: DashboardSpec = { ...v1Dashboard, version: 2 } as DashboardSpec;
    saveDashboards([v2]);
    assert.deepEqual(loadDashboards(), [v2]);
  });

  it('parseDashboardFile migrates an imported version-1 file the same way', () => {
    const parsed = parseDashboardFile(JSON.stringify(v1Dashboard));
    assert.equal(parsed.version, 2);
    assert.equal(parsed.charts.length, 1);
    // Re-identified on import, same as a version-2 file (unrelated to migration).
    assert.notEqual(parsed.id, v1Dashboard.id);
  });
});
