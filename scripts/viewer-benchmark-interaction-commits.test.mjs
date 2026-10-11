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

const { measureInteractionCommits, VIEWPORT_CANVAS } = await tsImport('../tests/benchmark/interaction-commits.ts', import.meta.url);

/**
 * A page stub: a minimap canvas precedes the viewport in document order, as on
 * FZK (#6993 review). `evaluate` runs the probe in this realm, against a fake
 * `document` and the viewer's trace global.
 */
function stubPage({ viewportUnderPointer = true } = {}) {
  let commits = 0;
  let clock = 0;
  const moves = [];
  const viewport = { tagName: 'CANVAS', className: 'w-full' };
  const minimap = { tagName: 'CANVAS', className: 'maplibregl-canvas' };
  const boxes = { [VIEWPORT_CANVAS]: { x: 200, y: 100, width: 600, height: 400 }, canvas: { x: 900, y: 500, width: 100, height: 100 } };
  const locator = (selector) => ({
    first() { return this; },
    boundingBox: async () => boxes[selector] ?? null,
    click: async () => { commits += 3; },
  });
  const page = {
    locator,
    getByRole: () => locator('button'),
    mouse: { move: async (x, y) => { moves.push([x, y]); commits += 1; } },
    waitForTimeout: async (ms) => { clock += ms; },
    evaluate: async (fn, arg) => fn(arg),
  };
  globalThis.__IFC_LITE_LOAD_TRACE__ = { sessionCounters: () => ({ 'react.commits': commits }) };
  globalThis.__ifc_lite_viewer_store__ = { getState: () => ({ hoverState: { entityId: null } }) };
  globalThis.document = {
    querySelector: (selector) => (selector === VIEWPORT_CANVAS ? viewport : minimap),
    elementFromPoint: () => (viewportUnderPointer ? viewport : minimap),
  };
  return { page, moves, now: () => clock };
}

function cleanupStub() {
  delete globalThis.__IFC_LITE_LOAD_TRACE__;
  delete globalThis.__ifc_lite_viewer_store__;
  delete globalThis.document;
}

test('#6993 review: hover moves to the centre of the VIEWPORT canvas, not the first canvas (a minimap)', async () => {
  const { page, moves, now } = stubPage();
  try {
    const result = await measureInteractionCommits(page, now);
    assert.deepEqual(result.errors, {});
    assert.deepEqual(moves[0], [500, 300], 'the pointer went to the minimap, or nowhere');
    assert.deepEqual(moves.slice(1), [[1, 1]], 'the pointer leaves the viewport before the panel step');
    // The rest move's own commit lands before panelOpen's quiet start, not in it.
    assert.deepEqual(result.commits, { select: 3, hover: 1, panelOpen: 3 });
  } finally {
    cleanupStub();
  }
});

test('#6993 review: hover refuses to measure when something else covers the viewport centre', async () => {
  const { page, moves, now } = stubPage({ viewportUnderPointer: false });
  try {
    const result = await measureInteractionCommits(page, now);
    assert.equal(result.commits.hover, null);
    assert.match(result.errors.hover, /covered by CANVAS\.maplibregl-canvas/);
    assert.deepEqual(moves, [], 'no pointer move may be charged as a viewport hover');
  } finally {
    cleanupStub();
  }
});
