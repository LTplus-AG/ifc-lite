/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7005: span metrics preserve their original clock epochs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';

const { metricsFromLoadTrace } = await tsImport('../tests/benchmark/load-trace-metrics.ts', import.meta.url);

const snapshot = (overrides = {}) => ({
  loadId: 'm1',
  attrs: {},
  start: 500,
  end: 900.4,
  spans: [
    { name: 'file.read', thread: 'main', start: 501, end: 513.2 },
    { name: 'geometry.pool', thread: 'main', start: 550, end: null },
    { name: 'geometry.firstBatch', thread: 'main', start: 500, end: 640.3, milestone: true },
    { name: 'geometry.firstVisible', thread: 'main', start: 500, end: overrides.firstVisibleEnd ?? 700.2, milestone: true },
    { name: 'geometry.streamComplete', thread: 'main', start: 500, end: 800.6, milestone: true },
  ],
});

test('#6956 span metrics keep each console metric\'s epoch', () => {
  assert.deepEqual(metricsFromLoadTrace(snapshot()), {
    totalWallClockMs: 400,
    fileReadMs: 12,
    firstBatchWaitMs: 90, // pool start, not load start
    firstVisibleGeometryMs: 200,
    streamCompleteMs: 301,
    geometryStreamingMs: 301,
  });
  assert.deepEqual(metricsFromLoadTrace(null), {});
});
