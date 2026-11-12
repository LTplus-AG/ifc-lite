/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// WebGL at the pick: a start-screen mark drawing around the pick changes how Chrome presents on Xvfb,
// so every browser row says whether it happened, and a cell mixing both states says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function load(path) {
  let failure = null;
  const mod = await import(path).catch((error) => { failure = error; return null; });
  assert.ok(mod, `${path} did not load (${failure?.name ?? 'unknown'})`);
  return mod;
}

test('draws in the second before the pick or during the open mark the open as WebGL-active', async () => {
  const { webglAroundPick } = await load('./viewer-load-probe.mjs');
  const before = webglAroundPick({ times: [100, 4400, 4600] }, 5000, 9000);
  assert.equal(before.webglDrawsBeforePick, 2, 'two draws within 1 s before the pick');
  assert.equal(before.webglLastDrawBeforePickMs, 400);
  assert.equal(before.webglActiveAtPick, true);
  const during = webglAroundPick({ times: [5200] }, 5000, 9000);
  assert.equal(during.webglDrawsDuringOpen, 1);
  assert.equal(during.webglActiveAtPick, true, 'a mark still drawing after the pick counts');
  const old = webglAroundPick({ times: [100, 3000] }, 5000, 9000);
  assert.equal(old.webglActiveAtPick, false, 'a mark that stopped 2 s before the pick does not');
  assert.equal(old.webglLastDrawBeforePickMs, 2000, 'but its distance is recorded');
  assert.equal(webglAroundPick({ times: [9500] }, 5000, 9000).webglActiveAtPick, false, 'draws after interactive are outside the open');
});

test('no counter is unknown, never inactive', async () => {
  const { webglAroundPick } = await load('./viewer-load-probe.mjs');
  assert.equal(webglAroundPick(null, 5000, 9000).webglActiveAtPick, null);
  assert.equal(webglAroundPick({ times: [] }, Number.NaN, 9000).webglActiveAtPick, null);
});

test('the report names a cell that mixes WebGL-active and quiet picks', async () => {
  const { webglPickRows } = await load('./load-scoreboard-report.mjs');
  const row = (side, active, frames) => ({ ok: true, fixture: 'FZK', lane: 'browser-cold', side, webglActiveAtPick: active, framesToInteractive: frames });
  const rows = webglPickRows([row('base', true, 30), row('base', false, 20), row('base', false, 22), row('branch', false, 21), row('branch', null, 25)]);
  assert.equal(rows.length, 2);
  assert.match(rows.find((r) => r.includes('| base |')), /\| 3 \| 1 \| MIXED \| 22 \|/);
  assert.match(rows.find((r) => r.includes('| branch |')), /none \(\+1 unknown\)/);
  const mixedUnknown = webglPickRows([row('base', true, 1), row('base', false, 1), row('base', null, 1)]);
  assert.match(mixedUnknown[0], /MIXED \(\+1 unknown\)/, 'MIXED stays visible beside unknown samples (review #9857)');
  assert.deepEqual(webglPickRows([{ ok: true, fixture: 'F', lane: 'browser-cold', side: 'base' }]), [], 'rows without the field are skipped');
});

test('frames are counted at the measured boundaries from in-page timestamps; no counter is null (review #9857)', async () => {
  const { framesBetween } = await load('./viewer-load-probe.mjs');
  assert.equal(framesBetween([100, 4990, 5000, 6000, 9000, 9001], 5000, 9000), 3, 'only frames from the pick to interactive');
  assert.equal(framesBetween(null, 5000, 9000), null, 'counter not installed');
  assert.equal(framesBetween([1], Number.NaN, 9000), null);
});
