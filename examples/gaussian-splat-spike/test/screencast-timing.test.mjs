/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { captionWindows, intervalStats, screencastConcat } from '../screencast-timing.mjs';

const frames = [{ n: 1, ts: 100 }, { n: 2, ts: 100.0333 }, { n: 3, ts: 100.4333 }, { n: 4, ts: 100.4666 }];

test('concat durations are the captured intervals, so a stall stays a held frame (#8567)', () => {
  const script = screencastConcat(frames);
  const durations = [...script.matchAll(/^duration ([0-9.]+)$/gm)].map(m => Number(m[1]));
  assert.deepEqual(durations.slice(0, 3).map(d => Math.round(d * 1000)), [33, 400, 34]);
  assert.equal(Math.round(durations[3] * 1000), 33, 'last nominal frame is rounded on the same absolute timeline');
  // Total timeline is rounded once to milliseconds, not once per interval.
  assert.equal(Math.round(durations.reduce((a, b) => a + b, 0) * 1000), 500);
  const files = [...script.matchAll(/^file '(.+)'$/gm)].map(m => m[1]);
  assert.deepEqual(files, ['frames/000001.jpg', 'frames/000002.jpg', 'frames/000003.jpg', 'frames/000004.jpg', 'frames/000004.jpg']);
});

test('concat refuses unordered or too-short captures (#8567)', () => {
  assert.throws(() => screencastConcat([{ n: 1, ts: 5 }]), /two captured frames/);
  assert.throws(() => screencastConcat([{ n: 1, ts: 5 }, { n: 2, ts: 5 }]), /not after/);
});

test('interval stats expose stalls instead of averaging them away (#8567)', () => {
  const stats = intervalStats(frames);
  assert.equal(stats.frames, 4);
  assert.equal(stats.max, 400);
  assert.equal(stats.over50ms, 1);
  assert.ok(Math.abs(stats.seconds - 0.467) < 1e-3);
});

test('caption windows skip silent steps and refuse overlaps (#8567)', () => {
  const windows = captionWindows([
    { caption: 'Load', start: 0.4, end: 6 }, { caption: '', start: 6, end: 7 }, { caption: 'Orbit', start: 7, end: 9 },
  ]);
  assert.deepEqual(windows.map(w => w.caption), ['Load', 'Orbit']);
  assert.throws(() => captionWindows([{ caption: 'A', start: 0, end: 5 }, { caption: 'B', start: 4, end: 6 }]), /overlaps/);
  assert.throws(() => captionWindows([{ caption: 'A', start: 3, end: 3 }]), /no duration/);
});
