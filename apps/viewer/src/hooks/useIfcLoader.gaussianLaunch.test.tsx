/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8568 launch: the published limits, the per-scene splat budget and the
 * content-free diagnostics, through the real mounted `useIfcLoader().loadFile`.
 * What is real and what is faked is listed in `test/gaussian-loader-harness.ts`.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { beforeSend, posthog } from '@/lib/analytics';
import { gaussianPly, gaussianTestRenderer, installInThreadGaussianWorker, setGaussianBuild } from '@/test/gaussian-loader-harness';
import { noteGaussianDeviceEvent } from './ingest/gaussianTelemetry.js';
import { useIfcLoader } from './useIfcLoader.js';
import { useIfcFederation } from './useIfcFederation.js';
import { setGlobalRendererRef } from './useBCF.js';

const BASE = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const CENTRES: Array<[number, number, number]> = [[1.25, 2.5, 3.75], [4, 5, 6], [-2, 0, 1]];

/**
 * A Gaussian PLY whose header claims `count` records. Its reported size covers
 * that payload, but only the header exists: any read of the body (a decode)
 * throws, so a refusal here is provably before decoding.
 */
function claimedPly(name: string, count: number, restColumns = 0, size?: number): File {
  const names = [...BASE, ...Array.from({ length: restColumns }, (_, i) => `f_rest_${i}`)];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${count}\n${names.map(n => `property float ${n}\n`).join('')}end_header\n`;
  const file = new File([header, new Uint8Array(names.length * 4)], name);
  Object.defineProperty(file, 'size', { value: size ?? header.length + count * names.length * 4 });
  file.arrayBuffer = async () => { throw new Error('the capture body was read before its refusal'); };
  return file;
}

let loader: ReturnType<typeof useIfcLoader> | null = null;
let federation: ReturnType<typeof useIfcFederation>;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let worker: ReturnType<typeof installInThreadGaussianWorker>;
let gpu: ReturnType<typeof gaussianTestRenderer>;
let restoreBuild: () => void = () => {};
let captured: Array<[string, Record<string, unknown>]> = [];

function Probe() {
  loader = useIfcLoader();
  federation = useIfcFederation(loader.loadFile);
  return null;
}
const load = (file: File, target: Parameters<NonNullable<typeof loader>['loadFile']>[1]) =>
  act(async () => { await loader!.loadFile(file, target); });
const error = () => String(useViewerStore.getState().error);
const captureEvents = (name: string) => captured.filter(([event]) => event === name).map(([, properties]) => properties);

beforeEach(async () => {
  restoreBuild = setGaussianBuild(undefined);
  captured = [];
  mock.method(posthog, 'capture', (event: string, properties?: Record<string, unknown>) => { captured.push([event, { ...properties }]); });
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  modelIndices(new Map());
  gpu = gaussianTestRenderer();
  setGlobalRendererRef({ current: gpu.renderer as Renderer });
  worker = installInThreadGaussianWorker();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Probe />); });
});

afterEach(async () => {
  restoreBuild();
  mock.restoreAll();
  worker.restore();
  setGlobalRendererRef({ current: null });
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  host?.remove();
  host = null;
  useViewerStore.getState().clearAllModels();
  modelIndices(new Map());
});

/** Refused before any decoder worker, renderer asset or model registration. */
function assertRefusedBeforeDecode(modelId: string): void {
  assert.equal(worker.stats.created, 0, 'no decoder worker was created');
  assert.equal(gpu.renderer.gaussianSplats.getStats().assets, 0, 'no renderer asset was allocated');
  assert.equal(useViewerStore.getState().models.has(modelId), false, 'the refused capture registered no model');
  assert.equal(useViewerStore.getState().loading, false);
}

describe('Gaussian launch limits refuse before decoding (#8568)', () => {
  it('a capture over 500 MB', async () => {
    const big = new File([new Uint8Array(32)], 'big.splat');
    Object.defineProperty(big, 'size', { value: 612_300_000 });
    big.arrayBuffer = async () => { throw new Error('read before refusal'); };
    await load(big, { kind: 'federated', modelId: 'big' });
    assert.equal(error(), 'This capture is 612.3 MB. Gaussian captures can be at most 500 MB.');
    assertRefusedBeforeDecode('big');
    const ply = claimedPly('big.ply', 10, 0, 500_000_001);
    await load(ply, { kind: 'federated', modelId: 'big-ply' });
    assert.match(error(), /Gaussian captures can be at most 500 MB\./, 'Gaussian PLY has the same size limit');
    assertRefusedBeforeDecode('big-ply');
  });

  it('a capture with more splats than a scene can hold', async () => {
    await load(claimedPly('dense.ply', 1_000_001), { kind: 'federated', modelId: 'dense' });
    assert.equal(error(), 'This capture has 1,000,001 splats. A scene can hold at most 1,000,000 splats.');
    assertRefusedBeforeDecode('dense');
  });

  it('a capture with spherical harmonics above degree 3', async () => {
    await load(claimedPly('sh4.ply', 2, 72), { kind: 'federated', modelId: 'sh4' });
    assert.equal(error(), 'This capture uses spherical harmonics degree 4. Degree 3 or lower is supported.');
    assertRefusedBeforeDecode('sh4');
  });

  it('degree 3 itself is admitted', async () => {
    const names = [...BASE, ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`)];
    const header = `ply\nformat binary_little_endian 1.0\nelement vertex 1\n${names.map(n => `property float ${n}\n`).join('')}end_header\n`;
    const body = new DataView(new ArrayBuffer(names.length * 4));
    body.setFloat32(names.indexOf('rot_0') * 4, 1, true);
    await load(new File([header, body.buffer], 'sh3.ply'), { kind: 'federated', modelId: 'sh3' });
    assert.equal(useViewerStore.getState().models.get('sh3')?.gaussianSplat?.shDegree, 3, error());
  });

  it('a load that would take the scene past 1,000,000 splats, counting loads still decoding', async () => {
    await load(gaussianPly('resident.ply', CENTRES), { kind: 'federated', modelId: 'resident' });
    assert.ok(useViewerStore.getState().models.get('resident')?.gaussianSplat, error());
    const createdAfterFirst = worker.stats.created;
    await load(claimedPly('over.ply', 999_998), { kind: 'federated', modelId: 'over' });
    assert.equal(error(), 'Opening this capture would bring the scene to 1,000,001 splats, over the 1,000,000 limit. Remove a capture, then try again.');
    assert.equal(worker.stats.created, createdAfterFirst, 'the over-budget capture was never decoded');
    assert.equal(useViewerStore.getState().models.has('over'), false);
    assert.equal(gpu.renderer.gaussianSplats.getStats().assets, 1, 'the resident capture is untouched');

    // Removing the resident capture frees its share of the budget.
    useViewerStore.getState().removeModel('resident');
    const release = worker.hold();
    await act(async () => {
      const decoding = loader!.loadFile(gaussianPly('decoding.ply', CENTRES), { kind: 'federated', modelId: 'decoding' });
      for (let i = 0; i < 100 && worker.stats.created === createdAfterFirst; i++) await new Promise(resolve => setTimeout(resolve, 10));
      // Federated adds stay independent: the decoding load is still current while this one is refused.
      await loader!.loadFile(claimedPly('concurrent.ply', 999_998), { kind: 'federated', modelId: 'concurrent' });
      assert.match(error(), /bring the scene to 1,000,001 splats/, 'an in-flight load holds its share of the budget');
      release();
      await decoding;
    });
    assert.equal(useViewerStore.getState().models.get('decoding')?.gaussianSplat?.count, 3, 'the in-flight load completed');
    assert.equal(useViewerStore.getState().models.has('concurrent'), false);
  });
});

describe('Gaussian capture diagnostics are content-free (#8568)', () => {
  const ALLOWED: Record<string, readonly string[]> = {
    outcome: ['completed', 'failed', 'cancelled', 'refused'],
    format: ['gaussian-ply', 'splat'],
    size_bucket: ['lt_10mb', '10_50mb', '50_200mb', '200_500mb', 'gt_500mb'],
    splat_bucket: ['unknown', 'lt_100k', '100k_500k', '500k_1m', 'gt_1m'],
  };

  function assertContentFree(properties: Record<string, unknown>, fileName: string, fileSize: number): void {
    for (const [key, value] of Object.entries(properties)) {
      if (key === 'code') assert.match(String(value), /^gaussian_[a-z_]+$/, 'a fixed failure id');
      else assert.ok(ALLOWED[key]?.includes(String(value)), `${key}=${String(value)} is a declared, closed value`);
    }
    const serialized = JSON.stringify(properties);
    for (const leak of [fileName, fileName.replace(/\.[^.]+$/, ''), String(fileSize), '1.25', '3.75', 'blob:', '/']) {
      assert.ok(!serialized.includes(leak), `payload carries no ${leak}`);
    }
    // The before_send pipeline keeps the payload whole: nothing in it needed scrubbing.
    assert.deepEqual(beforeSend({ event: 'gaussian_capture_load', properties: { ...properties } })?.properties, properties);
  }

  it('completed, refused, failed and cancelled loads each report one closed-vocabulary event', async () => {
    const completed = gaussianPly('Client Plant Room 12.ply', CENTRES);
    await load(completed, { kind: 'federated', modelId: 'completed' });
    setGaussianBuild('disabled');
    const refused = new File([new Uint8Array(64)], 'Secret Site Survey.splat');
    await load(refused, { kind: 'federated', modelId: 'refused' });
    setGaussianBuild(undefined);
    gpu = gaussianTestRenderer({ maxStorageBufferBindingSize: 16, maxBufferSize: 16 });
    setGlobalRendererRef({ current: gpu.renderer as Renderer });
    const failed = gaussianPly('Unreleased Tower.ply', CENTRES);
    await load(failed, { kind: 'federated', modelId: 'failed' });
    gpu = gaussianTestRenderer();
    setGlobalRendererRef({ current: gpu.renderer as Renderer });
    const release = worker.hold();
    const cancelled = gaussianPly('Cancelled Lobby.ply', CENTRES);
    await act(async () => {
      const pending = loader!.loadFile(cancelled, { kind: 'federated', modelId: 'cancelled' });
      await new Promise(resolve => setTimeout(resolve, 20));
      useViewerStore.getState().activeLoadCanceller?.();
      release();
      await pending;
    });

    const events = captureEvents('gaussian_capture_load');
    assert.deepEqual(events, [
      { outcome: 'completed', format: 'gaussian-ply', size_bucket: 'lt_10mb', splat_bucket: 'lt_100k' },
      { outcome: 'refused', code: 'gaussian_disabled', format: 'splat', size_bucket: 'lt_10mb', splat_bucket: 'lt_100k' },
      { outcome: 'failed', code: 'gaussian_load_failed', format: 'gaussian-ply', size_bucket: 'lt_10mb', splat_bucket: 'lt_100k' },
      { outcome: 'cancelled', format: 'gaussian-ply', size_bucket: 'lt_10mb', splat_bucket: 'lt_100k' },
    ]);
    [completed, refused, failed, cancelled].forEach((file, i) => assertContentFree(events[i], file.name, file.size));
  });

  it('limit refusals report their limit, and malformed input reports no splat count', async () => {
    await load(claimedPly('Private Hangar.ply', 1_000_001), { kind: 'federated', modelId: 'dense' });
    await load(new File([new Uint8Array(31)], 'Broken Scan.splat'), { kind: 'federated', modelId: 'broken' });
    const [dense, broken] = captureEvents('gaussian_capture_load');
    assert.deepEqual(dense, { outcome: 'refused', code: 'gaussian_limit_capture_splats', format: 'gaussian-ply', size_bucket: '50_200mb', splat_bucket: 'gt_1m' });
    assert.deepEqual(broken, { outcome: 'refused', code: 'gaussian_invalid_input', format: 'splat', size_bucket: 'lt_10mb', splat_bucket: 'unknown' });
  });

  it('device loss and recovery are counted only while a capture is loaded', async () => {
    noteGaussianDeviceEvent('lost');
    assert.deepEqual(captureEvents('gaussian_capture_device'), [], 'no capture: no capture diagnostic');
    await load(gaussianPly('Device Test.ply', CENTRES), { kind: 'federated', modelId: 'device' });
    noteGaussianDeviceEvent('lost');
    noteGaussianDeviceEvent('recovered');
    noteGaussianDeviceEvent('recovery_failed');
    const events = captureEvents('gaussian_capture_device');
    assert.equal(events.length, 3);
    const [lost, recovered, failed] = events;
    assert.equal(lost.phase, 'lost');
    assert.equal(recovered.phase, 'recovered');
    assert.equal(failed.phase, 'recovery_failed');
    assert.equal((recovered.loss_count as number) - (lost.loss_count as number), 0);
    assert.equal((recovered.recovery_count as number) - (lost.recovery_count as number), 1);
    for (const event of events) {
      assert.deepEqual(Object.keys(event).sort(), ['loss_count', 'phase', 'recovery_count']);
      assert.deepEqual(beforeSend({ event: 'gaussian_capture_device', properties: { ...event } })?.properties, event);
    }
  });

  it('before_send drops anything undeclared from a capture event', () => {
    const scrubbed = beforeSend({ event: 'gaussian_capture_load', properties: {
      outcome: 'completed', format: 'splat', size_bucket: 'lt_10mb', splat_bucket: 'lt_100k',
      file_name: 'Plant.ply', url: 'https://example.test/plant.splat', x: 1.25, splats: 912_345, outcome_detail: 'x', code: 'Plant.ply',
    } });
    assert.deepEqual(scrubbed?.properties, { outcome: 'completed', format: 'splat', size_bucket: 'lt_10mb', splat_bucket: 'lt_100k' });
  });
});

// PR #8745: the complete SDK before_send pipeline must fail closed.
for (const event of ['gaussian_capture_load', 'gaussian_capture_device']) {
  it(`${event} before_send rejects SDK content and invalid known values (#8745)`, () => {
    const properties = {
      outcome: 'completed', format: 'Plant.splat', size_bucket: 12345678,
      splat_bucket: 'lt_100k', phase: 'lost', loss_count: 1, recovery_count: 12345678,
      $current_url: 'https://example.test/private/site?secret=1', $pathname: '/private/site',
      $host: 'private.test', $referrer: 'https://private.test', $title: 'Plant',
      $unknown: 'Plant.splat', $bytes: 12345678, $coordinates: [1.25, 2.5, 3.75],
      $lib: 'web', $session_id: '01900000-0000-7000-8000-000000000001',
      token: 'phc_12345678901234567890', distinct_id: '01900000-0000-7000-8000-000000000002',
    };
    const sdk = { $lib: properties.$lib, $session_id: properties.$session_id, token: properties.token, distinct_id: properties.distinct_id };
    assert.deepEqual(beforeSend({ event, properties })?.properties, event.endsWith('_load')
      ? { ...sdk, outcome: 'completed', splat_bucket: 'lt_100k' }
      : { ...sdk, phase: 'lost', loss_count: 1 });
  });
}

it('a live capture reload owns one scene share; growth, failure and cancellation preserve the budget (#8745)', async () => {
  const { reserveSceneSplats } = await import('./ingest/gaussianSceneBudget.js');
  const { reloadGaussianCapture } = await import('./ingest/gaussianReload.js');
  await load(gaussianPly('live.ply', CENTRES), { kind: 'federated', modelId: 'live' });
  const state = useViewerStore.getState();
  const original = state.models.get('live')!;
  state.updateModel('live', { gaussianSplat: { ...original.gaussianSplat!, count: 600_000 } });
  const models = () => useViewerStore.getState().models;
  const hold = reserveSceneSplats(600_000, models(), 'live');
  assert.ok(hold.ok, '600k replacing 600k is admitted');
  try {
    assert.equal(reserveSceneSplats(400_001, models()).ok, false, 'other loads see the replacement reservation');
  } finally { hold.release(); hold.release(); }
  const shrinking = reserveSceneSplats(300_000, models(), 'live');
  assert.ok(shrinking.ok);
  try { assert.equal(reserveSceneSplats(400_001, models()).ok, false, 'rollback must retain the original share'); }
  finally { shrinking.release(); }
  await load(gaussianPly('other.ply', CENTRES), { kind: 'federated', modelId: 'other' });
  const other = models().get('other')!;
  state.updateModel('other', { gaussianSplat: { ...other.gaussianSplat!, count: 400_000 } });
  assert.equal(reserveSceneSplats(600_001, models(), 'live').ok, false, 'growth plus other captures exceeds the limit');
  state.removeModel('other');
  state.updateModel('live', { gaussianSplat: { ...original.gaussianSplat!, count: 1_000_000 } });
  // Exercise actual canonical failure/cancellation paths, then try the budget
  // again: neither may release the still-live original or retain a new hold.
  const originalAdd = gpu.renderer.gaussianSplats.add;
  gpu.renderer.gaussianSplats.add = async () => { throw new Error('upload refused'); };
  const failed = await act(async () => reloadGaussianCapture('live', federation));
  assert.equal(failed.ok, false);
  assert.equal(reserveSceneSplats(1, models()).ok, false, 'failure preserves original million');
  // Restore the same renderer's upload method without orphaning the original.
  gpu.renderer.gaussianSplats.add = originalAdd;
  const release = worker.hold();
  await act(async () => {
    const pending = reloadGaussianCapture('live', federation);
    await new Promise(resolve => setTimeout(resolve, 30));
    useViewerStore.getState().activeLoadCanceller?.();
    release();
    assert.equal((await pending).ok, false);
  });
  assert.equal(reserveSceneSplats(1, models()).ok, false, 'cancellation preserves original million');
  const result = await act(async () => reloadGaussianCapture('live', federation));
  assert.ok(result.ok, error());
  assert.equal(models().has('live'), false);
  assert.equal(models().get(result.modelId)?.gaussianSplat?.count, 3);
});

for (const removeOriginal of [false, true]) {
  it(`reload keeps one logical share while fingerprint is paused; original removed=${removeOriginal} (#8745 round 2)`, async () => {
    const { reserveSceneSplats } = await import('./ingest/gaussianSceneBudget.js');
    const { reloadGaussianCapture } = await import('./ingest/gaussianReload.js');
    await load(gaussianPly('paused.ply', CENTRES), { kind: 'federated', modelId: 'original' });
    const state = useViewerStore.getState();
    const original = state.models.get('original')!;
    state.updateModel('original', { gaussianSplat: { ...original.gaussianSplat!, count: 600_000 } });
    const file = original.sourceFile!;
    const slice = file.slice.bind(file);
    let releaseFingerprint = () => {};
    const gate = new Promise<void>(resolve => { releaseFingerprint = resolve; });
    let published = () => {};
    const publication = new Promise<void>(resolve => { published = resolve; });
    file.slice = (start, end, type) => {
      const blob = slice(start, end, type);
      if ([...useViewerStore.getState().models.values()].some(m => m.id !== 'original' && m.gaussianSplat)) {
        const read = blob.arrayBuffer.bind(blob);
        blob.arrayBuffer = async () => { published(); await gate; return read(); };
      }
      return blob;
    };
    let releaseConcurrent = () => {};
    await act(async () => {
      const pending = reloadGaussianCapture('original', federation);
      try {
        // Publication is real; only the source File's fingerprint read is held.
        await publication;
        assert.equal(useViewerStore.getState().models.size, 2);
        const concurrent = reserveSceneSplats(400_000, useViewerStore.getState().models);
        assert.ok(concurrent.ok, '600k logical reload + 400k fits despite two published model rows');
        releaseConcurrent = concurrent.release;
        if (removeOriginal) state.removeModel('original');
        assert.equal(reserveSceneSplats(1, useViewerStore.getState().models).ok, false,
          'the transaction retains its single 600k share until swap/rollback, even after source removal');
        releaseFingerprint();
        const result = await pending;
        assert.equal(result.ok, !removeOriginal);
        assert.equal(useViewerStore.getState().models.size, removeOriginal ? 0 : 1);
        const after = reserveSceneSplats(removeOriginal ? 600_000 : 599_997, useViewerStore.getState().models);
        assert.ok(after.ok, 'swap/rollback released the transaction hold');
        after.release();
      } finally {
        releaseFingerprint();
        await pending;
        releaseConcurrent();
        file.slice = slice;
      }
    });
  });
}
