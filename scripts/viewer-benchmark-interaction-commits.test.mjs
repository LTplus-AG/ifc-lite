/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6993: React commits per interaction are counted from a quiet page to the
// next quiet point, so background commits before the click are not charged to
// it and late commits the click causes are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';

const { commitsFor, waitForQuietCommits } = await tsImport('../tests/benchmark/interaction-commits.ts', import.meta.url);

/** A virtual clock; `schedule` lands commits at given times. */
function fakeProbe({ commitsAt = [], available = true } = {}) {
  let t = 0;
  const pending = [...commitsAt];
  const probe = {
    commits: 0,
    now: () => t,
    pause: async (ms) => { t += ms; },
    readCommits: async () => {
      if (!available) return null;
      while (pending.length && pending[0] <= t) { pending.shift(); probe.commits++; }
      return probe.commits;
    },
    schedule: (...offsets) => { for (const o of offsets) pending.push(t + o); pending.sort((a, b) => a - b); },
  };
  return probe;
}

const OPTS = { before: { quietMs: 2000, maxMs: 30000, pollMs: 100 }, after: { quietMs: 1000, maxMs: 30000, pollMs: 100 } };

test('background commits before the interaction are not charged to it; its late commits are', async () => {
  const probe = fakeProbe({ commitsAt: [500, 1500] }); // the load's tail
  const n = await commitsFor(probe, async () => probe.schedule(0, 50, 900), OPTS);
  assert.equal(n, 3, 'two immediate commits and one 900 ms later all belong to the click');
  assert.equal(probe.commits, 5);
});

test('an interaction that causes nothing counts 0', async () => {
  const probe = fakeProbe();
  assert.equal(await commitsFor(probe, async () => {}, OPTS), 0);
});

test('a page that never goes quiet is unmeasurable, not a number', async () => {
  const probe = fakeProbe({ commitsAt: Array.from({ length: 400 }, (_, i) => i * 150) });
  await assert.rejects(commitsFor(probe, async () => {}, OPTS), /never went quiet before/);
  assert.equal(await waitForQuietCommits(fakeProbe({ available: false }), OPTS.before), null);
});
