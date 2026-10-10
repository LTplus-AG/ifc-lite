/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Report-admission invariants using preserved real reports; no new GPU run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { requirePassedDensityReport, requireRendererDensityOracle, runRendererDensityControls } from './renderer-density-admission.mjs';

function archived(name) {
  return JSON.parse(gunzipSync(readFileSync(new URL(`./evidence/bounded-depth-readback-6881/${name}.json.gz`, import.meta.url))));
}
const complete = () => archived('renderer-same-render-oracles');

test('all 27 archived same-render samples satisfy admission (#6881)', () => {
  const data = complete();
  assert.equal(data.sameRenderDepth.length, 27);
  assert.doesNotThrow(() => requireRendererDensityOracle(data.reports, data.sameRenderDepth));
});

for (const name of ['renderer-density-controls', 'renderer-base-density-controls']) {
  test(`the actual ${name} archive does not certify absent depth samples (#6881)`, () => {
    const data = archived(name);
    assert.throws(() => requireRendererDensityOracle(data.reports, data.sameRenderDepth), /depth samples/);
  });
}

test('empty comparisons cannot certify three passed witnesses (#6881)', () => {
  const data = complete();
  assert.throws(() => requireRendererDensityOracle(data.reports, []), /depth samples/);
});

for (const status of ['skipped', 'failed', 'pending']) {
  test(`${status} witness cannot admit otherwise matching samples (#6881)`, () => {
    const data = complete();
    data.reports[1].report.status = status;
    assert.throws(() => requirePassedDensityReport(1.5, data.reports[1].report), /did not pass/);
    assert.throws(() => requireRendererDensityOracle(data.reports, data.sameRenderDepth), /did not pass/);
  });
}

test('an incomplete density cannot borrow another density samples (#6881)', () => {
  const data = complete();
  data.sameRenderDepth.splice(data.sameRenderDepth.findIndex(sample => sample.density === 2), 1);
  assert.throws(() => requireRendererDensityOracle(data.reports, data.sameRenderDepth), /Density 2 has 8 depth samples/);
});

for (const change of ['missing', 'duplicate', 'unverified']) {
  test(`${change} witness report refuses admission (#6881)`, () => {
    const data = complete();
    if (change === 'missing') data.reports.pop();
    if (change === 'duplicate') data.reports[2] = data.reports[0];
    if (change === 'unverified') data.reports[0].report.system.hardwareVerified = false;
    assert.throws(() => requireRendererDensityOracle(data.reports, data.sameRenderDepth));
  });
}

for (const change of ['unread', 'mismatch', 'outside']) {
  test(`${change} depth sample refuses admission (#6881)`, () => {
    const data = complete();
    if (change === 'unread') data.sameRenderDepth[0].actual = null;
    if (change === 'mismatch') data.sameRenderDepth[0].actual ^= 1;
    if (change === 'outside') data.sameRenderDepth[0].x = data.sameRenderDepth[0].width;
    assert.throws(() => requireRendererDensityOracle(data.reports, data.sameRenderDepth));
  });
}

function controller(data, { status, omitSamples = false, rejectMap = false } = {}) {
  const window = {};
  const descriptor = { configurable: true, get: () => 1.5 };
  Object.defineProperty(window, 'devicePixelRatio', descriptor);
  const calls = [], removals = [];
  const document = {
    body: { append() {} },
    createElement: () => ({ style: {}, remove() { removals.push(true); } }),
  };
  const run = () => runRendererDensityControls({ window, document,
    runWitness: async (_canvas, observe) => {
      calls.push(window.devicePixelRatio);
      observe({});
      const report = structuredClone(data.reports.find(row => row.density === window.devicePixelRatio).report);
      if (status) report.status = status;
      return report;
    },
    observeDepthCopies: (_renderer, pending, density) => {
      if (rejectMap) pending.push(Promise.reject(new Error('supplied map terminal failure')));
      else if (!omitSamples) pending.push(...data.sameRenderDepth.filter(row => row.density === density));
    },
  });
  return { run, window, descriptor, calls, removals };
}

test('live controller admits the complete archive and restores exact density owner (#6881)', async () => {
  const probe = controller(complete());
  const result = await probe.run();
  assert.deepEqual(probe.calls, [1, 1.5, 2]);
  assert.equal(result.sameRenderDepth.length, 27);
  assert.equal(probe.removals.length, 3);
  assert.deepEqual(Object.getOwnPropertyDescriptor(probe.window, 'devicePixelRatio'),
    { ...probe.descriptor, enumerable: false, set: undefined });
});

test('live controller stops on a skipped witness and restores its canvas/descriptor (#6881)', async () => {
  const probe = controller(complete(), { status: 'skipped' });
  await assert.rejects(probe.run(), /did not pass/);
  assert.deepEqual(probe.calls, [1]);
  assert.equal(probe.removals.length, 1);
  assert.equal(probe.window.devicePixelRatio, 1.5);
});

test('live controller refuses successful witnesses without observed samples (#6881)', async () => {
  const probe = controller(complete(), { omitSamples: true });
  await assert.rejects(probe.run(), /depth samples/);
  assert.equal(probe.removals.length, 3);
  assert.equal(probe.window.devicePixelRatio, 1.5);
});

test('live controller joins supplied failed map deliveries before refusing (#6881)', async () => {
  const probe = controller(complete(), { rejectMap: true });
  await assert.rejects(probe.run(), /supplied map terminal failure/);
  assert.equal(probe.removals.length, 3);
  assert.equal(probe.window.devicePixelRatio, 1.5);
});
