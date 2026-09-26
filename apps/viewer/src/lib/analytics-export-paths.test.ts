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

describe('non-registry export attribution (#5844)', () => {
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
