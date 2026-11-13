/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The interactive mark's settled gate (viewer-load-probe.mjs interactiveProbe), driven in Node through the page
// globals the probe reads: the load trace, the viewer store, the arm state and the viewer's settled hook.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Loaded inside each test so a missing module fails that test, not the file (revert oracle).
async function load(path) {
  let failure = null;
  const mod = await import(path).catch((error) => { failure = error; return null; });
  assert.ok(mod, `${path} did not load (${failure?.name ?? 'unknown'})`);
  return mod;
}

const span = (name, start, end, extra = {}) => ({ name, start, end, ...extra });
// One page state: t0 = the arm, every time below is ms after it (the change event is at +0).
function page({ spans, loadEnd, settled = true, hook, settleAt = 400 }) {
  const t0 = performance.now() - 20000;
  const at = (ms) => (ms === null ? null : t0 + ms);
  globalThis.__benchT0 = t0;
  globalThis.__benchSettle = { at: at(settleAt), settlePaint: at(settleAt + 10), publish: at(300), publishPaint: at(310), change: t0 };
  globalThis.__IFC_LITE_LOAD_TRACE__ = { loads: () => [{ start: t0 + 1, end: at(loadEnd), attrs: {}, spans: spans.map((s) => ({ ...s, start: at(s.start), end: at(s.end) })) }] };
  globalThis.__ifc_lite_viewer_store__ = { getState: () => ({ loading: !settled, models: new Map([['m', { loadState: settled ? 'complete' : 'loading' }]]) }) };
  if (hook === undefined) delete globalThis.__ifc_lite_scene_settled__; else globalThis.__ifc_lite_scene_settled__ = hook;
}
const meta = [span('parser.complete', 50, 380)];

test('a fast-path load (store settled before any drain span exists) marks early under the span rule and is held by the settled gate (review: interactive mark)', async () => {
  const { interactiveProbe } = await load('./viewer-load-probe.mjs');
  // #9900 FZK, mode A: stream complete at 420, the load ended, no stream.queue and no drain span yet; the scene finalizes at 504.
  const early = [span('geometry.streamComplete', 0, 420), ...meta];
  page({ spans: early, loadEnd: 430, settleAt: 424 });
  const old = interactiveProbe(1);
  assert.ok(old, 'without the hook (a build from before the gate), the span rule marks here');
  assert.ok(old.interactiveMs < 504, `the old mark ${old.interactiveMs} precedes finalize end (504): nothing is drawn yet`);
  assert.equal(old.sceneSettledCheck, 'unavailable');
  // With the viewer's settled check: held while the scene is not settled.
  page({ spans: early, loadEnd: 430, settleAt: 424, hook: () => false });
  assert.equal(interactiveProbe(1), null, 'held: the viewer reports an unsettled scene');
  // The drain and finalize land; the viewer reports settled; the same arm state is polled again.
  const st = globalThis.__benchSettle;
  page({ spans: [...early, span('stream.queueDrain', 479, 502), span('camera.refit', 495, 500), span('scene.finalize', 502, 504)], loadEnd: 430, settleAt: 424, hook: () => true });
  globalThis.__benchSettle = st;
  const held = interactiveProbe(1);
  assert.ok(held.interactiveMs >= 504 - 0.001, `the new mark ${held.interactiveMs} is not before finalize end`);
  assert.ok(held.interactiveMsOldGate < 504, 'and the old rule\'s value is recorded beside it');
  assert.equal(held.sceneSettledCheck, 'settled');
});

test('a federated add and an adopted reopen keep their old marks: the gate never holds a settled scene', async () => {
  const { interactiveProbe } = await load('./viewer-load-probe.mjs');
  const cases = {
    // Federated add: final batches uploaded directly, no stream.queue, no finalize span.
    federated: { spans: [span('geometry.streamComplete', 0, 350), ...meta], loadEnd: 390 },
    // Adopted reopen: a scene snapshot adopted, no stream.queue, no finalize span.
    adopted: { spans: [span('geometry.streamComplete', 0, 200), span('scene.snapshotAdopted', 150, 150), ...meta], loadEnd: 390 },
    // Main cold load: streamed and finalized before the store settles.
    streamed: { spans: [span('geometry.streamComplete', 0, 300), span('stream.queue', 10, 300), span('stream.queueDrain', 300, 340), span('scene.finalize', 340, 360), ...meta], loadEnd: 390 },
  };
  for (const [name, c] of Object.entries(cases)) {
    page({ ...c });
    const before = interactiveProbe(1);
    page({ ...c, hook: () => true });
    const after = interactiveProbe(1);
    assert.ok(before && after, name);
    assert.equal(after.interactiveMs, before.interactiveMs, `${name}: same mark`);
    assert.equal(after.interactiveMsOldGate, before.interactiveMs, `${name}: old value recorded equal`);
    assert.equal(after.sceneSettleHeldMs, 0, `${name}: never held`);
  }
});

test('a scene that never settles ends the wait at the cap as a flagged sample, and the open fails with the reason', async () => {
  const { interactiveProbe } = await load('./viewer-load-probe.mjs');
  page({ spans: [span('geometry.streamComplete', 0, 420), ...meta], loadEnd: 430, hook: () => false });
  assert.equal(interactiveProbe(1), null);
  globalThis.__benchSettle.oldGate.at -= 15001; // the old rule was satisfied 15 s ago
  const capped = interactiveProbe(1);
  assert.equal(capped.sceneSettleTimedOut, true);
  assert.equal(capped.sceneSettledCheck, 'never settled');
  assert.ok(capped.sceneSettleHeldMs >= 15000);
});

test('present times keep the frames from the change event to the end of the window, relative and capped', async () => {
  const { presentTimes } = await load('./viewer-load-probe.mjs');
  assert.deepEqual(presentTimes([90, 100.04, 116.7, 2000, 5000], 100, 3100), [0, 16.7, 1900]);
  assert.equal(presentTimes(null, 100, 200), null, 'counter not installed: unknown, never "no frames"');
  assert.equal(presentTimes(Array.from({ length: 1000 }, (_, i) => 100 + i), 100, 5000, 600).length, 600);
});
