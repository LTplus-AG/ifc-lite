/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { posthog } from './analytics.js';
import { EVENT_FILE_DOWNLOADED } from './tours/events.js';
import { exportPresets } from './clash/persistence.js';
import { downloadLoadReportJSON } from './loadReport.js';
import { exportList, type ExportModel } from './lists/export/index.js';

describe('non-registry export attribution (#5844)', () => {
  it('counts a list CSV after its real browser download', async () => {
    const model: ExportModel = {
      title: 'Elements', generatedAt: '2026-09-26',
      columns: [{ id: 'name', label: 'Name', numeric: false, summed: false, width: 120 }],
      groups: null, rows: [['Wall']], groupColumnId: null, groupColumnIds: [],
      sumColumnIds: [], totals: { count: 1, sums: {} }, schedule: null,
    };
    const completed: Record<string, unknown>[] = [];
    const downloads: string[] = [];
    const capture = mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
      if (event === 'export_completed') completed.push(properties);
    });
    const listener = (event: Event) => downloads.push((event as CustomEvent<{ kind: string }>).detail.kind);
    window.addEventListener(EVENT_FILE_DOWNLOADED, listener);
    try {
      await exportList('csv', model);
    } finally {
      capture.mock.restore();
      window.removeEventListener(EVENT_FILE_DOWNLOADED, listener);
    }
    assert.deepEqual(downloads, ['csv']);
    assert.deepEqual(completed, [{ format: 'csv', surface: 'list_results', row_count: 1, column_count: 1 }]);
  });

  it('attributes a clash preset file and a load report once each after their downloads', () => {
    const completed: Record<string, unknown>[] = [];
    const downloads: string[] = [];
    const capture = mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
      if (event === 'export_completed') completed.push(properties);
    });
    const listener = (event: Event) => downloads.push((event as CustomEvent<{ kind: string }>).detail.kind);
    window.addEventListener(EVENT_FILE_DOWNLOADED, listener);
    try {
      exportPresets([]);
      downloadLoadReportJSON([]);
    } finally {
      capture.mock.restore();
      window.removeEventListener(EVENT_FILE_DOWNLOADED, listener);
    }
    assert.deepEqual(downloads, ['json', 'json']);
    assert.deepEqual(completed, [
      { format: 'json', surface: 'clash_results' },
      { format: 'json', surface: 'load_report' },
    ]);
  });
});
