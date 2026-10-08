/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeNightHistory, nightHistoryWindow, type NightAttempt } from './frame-gpu-night-history.js';

// Synthetic calendar invariants only: these are never real nightly evidence.
const history = (): NightAttempt[] => Array.from({ length: 7 }, (_, index) => ({
  night: `2026-10-${String(index + 1).padStart(2, '0')}`,
  startedAt: `2026-10-${String(index + 1).padStart(2, '0')}T02:00:00Z`,
  finishedAt: `2026-10-${String(index + 1).padStart(2, '0')}T02:05:00Z`,
  profileSha256: 'a'.repeat(64), receiptSha256: String(index + 1).repeat(64), status: 'ok',
}));

test('#6975 seven consecutive UTC nights permit artifact review without producing a threshold', () => {
  const result = nightHistoryWindow(history().reverse(), '2026-10-07');
  assert.equal(result.calendarReady, true);
  assert.deepEqual(result.consecutive.map((row) => row.night), history().map((row) => row.night));
  assert.equal(Reflect.has(result, 'threshold'), false);
  assert.equal(nightHistoryWindow(history(), '2026-10-08').calendarReady, false);
});

test('#6975 missing, refused and failed nights interrupt calibration rather than disappearing', () => {
  for (const status of ['refused', 'failed'] as const) {
    const rows = history(); rows[3].status = status;
    const window = nightHistoryWindow(rows, '2026-10-07');
    assert.equal(window.calendarReady, false);
    assert.equal(window.reason, `${status} scheduled night`);
    assert.equal(window.consecutive.length, 3);
  }
  const rows = history(); rows.splice(3, 1);
  assert.equal(nightHistoryWindow(rows, '2026-10-07').reason, 'missing scheduled night');
});

test('#6975 retries cannot replace refused nights or count twice toward calibration', () => {
  const rows = history();
  rows.push({ ...rows[3], status: 'refused', receiptSha256: 'f'.repeat(64) });
  for (const ordered of [rows, [...rows].reverse()]) {
    const result = nightHistoryWindow(ordered, '2026-10-07');
    assert.equal(result.calendarReady, false);
    assert.equal(result.reason, 'multiple attempts on one night');
  }
});

test('#6975 changing source/profile or reusing raw artifacts cannot qualify seven nights', () => {
  const profile = history(); profile[3].profileSha256 = 'b'.repeat(64);
  assert.equal(nightHistoryWindow(profile, '2026-10-07').reason, 'calibration profile changed');
  const receipts = history(); receipts[3].receiptSha256 = receipts[6].receiptSha256;
  assert.equal(nightHistoryWindow(receipts, '2026-10-07').reason, 'raw receipt reused across nights');
  const oldReuse = history();
  oldReuse.push({ ...oldReuse[0], night: '2026-10-08', startedAt: '2026-10-08T02:00:00Z', finishedAt: '2026-10-08T02:05:00Z' });
  assert.equal(nightHistoryWindow(oldReuse, '2026-10-08').reason, 'raw receipt reused across nights');
});

test('#6975 corrupt dates, missing receipt hashes, invalid status and intervals refuse all calibration', () => {
  for (const invalid of [
    { night: '2026-02-30' }, { startedAt: '2026-10-02T02:00:00Z' },
    { finishedAt: '2026-10-01T01:00:00Z' }, { receiptSha256: '' }, { status: 'skipped' },
  ]) {
    const rows = history(); Object.assign(rows[0], invalid);
    assert.throws(() => decodeNightHistory(rows));
    assert.throws(() => nightHistoryWindow(rows, '2026-10-07'));
  }
});
