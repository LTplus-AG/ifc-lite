/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The COPC sink's deviation refresh (#6880) must announce each completed
 * re-run, or the Deviation panel's statistics keep describing the chunks of
 * an earlier view while the heatmap moves on (#6872).
 */

import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '../../../store/index.js';
import { createCopcLodSink } from './copcLodSink.js';

afterEach(() => {
  useViewerStore.getState().setPointCloudDeviationComputed(false);
});

function sinkWith(computeDeviations: () => Promise<unknown>) {
  const renderer = { computeDeviations } as unknown as Renderer;
  return createCopcLodSink({ renderer, handle: { id: 1 } });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it('#6872 a settled pass that re-runs deviation bumps the revision only once the run completes', async () => {
  let finish: () => void = () => { throw new Error('deviation was not re-run'); };
  const sink = sinkWith(() => new Promise<void>((resolve) => { finish = resolve; }));
  useViewerStore.getState().setPointCloudDeviationComputed(true);
  const before = useViewerStore.getState().pointCloudDeviationRevision;

  sink.passSettled();
  await settle();
  // Mid-run the buffers are being rewritten: nothing may read them yet.
  assert.equal(useViewerStore.getState().pointCloudDeviationRevision, before);
  finish();
  await settle();
  assert.equal(useViewerStore.getState().pointCloudDeviationRevision, before + 1);
});

it('#6872 a failed or skipped deviation refresh leaves the revision alone', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    let calls = 0;
    const failing = sinkWith(async () => { calls++; throw new Error('device lost'); });
    const before = useViewerStore.getState().pointCloudDeviationRevision;
    useViewerStore.getState().setPointCloudDeviationComputed(true);
    failing.passSettled();
    await settle();
    assert.equal(calls, 1);
    assert.equal(useViewerStore.getState().pointCloudDeviationRevision, before);

    // No live deviation result: nothing re-runs, nothing to announce.
    useViewerStore.getState().setPointCloudDeviationComputed(false);
    failing.passSettled();
    await settle();
    assert.equal(calls, 1);
    assert.equal(useViewerStore.getState().pointCloudDeviationRevision, before);
  } finally {
    console.warn = originalWarn;
  }
});
