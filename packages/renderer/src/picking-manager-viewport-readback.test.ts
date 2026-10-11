/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Camera } from './camera.js';
import { PickingManager } from './picking-manager.js';
import type { PickResult } from './types.js';

const BOX_ID = 100;
const POINT_ID = 900;
type PickPath = 'point' | 'gpu-rectangle' | 'cpu-box-and-points';

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {
    promise,
    resolve(value: T) { assert.ok(resolve); resolve(value); },
    reject(reason: Error) { assert.ok(reject); reject(reason); },
  };
}

function readbackFixture(path: PickPath) {
  const camera = new Camera();
  camera.setAspect(100 / 80);
  const css = { width: 100, height: 80 };
  const canvas = {
    width: 200,
    height: 160,
    getBoundingClientRect: () => ({ ...css }),
  };
  const pointReadback = deferred<PickResult | null>();
  const rectReadback = deferred<Set<number>>();
  const submissions: Array<{ width: number; height: number }> = [];
  const picker = {
    pick: (_x: number, _y: number, width: number, height: number) => {
      submissions.push({ width, height });
      return pointReadback.promise;
    },
    pickRect: (_x0: number, _y0: number, _x1: number, _y1: number, width: number, height: number) => {
      submissions.push({ width, height });
      return rectReadback.promise;
    },
  };
  // Scene/GPU boundaries only choose the manager's branch and supply completed
  // data. Camera epochs, viewport measurement, and post-await rejection are real.
  const scene = {
    getMeshes: () => [],
    getBatchedMeshes: () => path === 'cpu-box-and-points' ? [{}] : [],
    getTexturedMeshes: () => [],
    isGeometryDataReleased: () => true,
    getInstancedTemplates: () => [],
    selectRect: () => new Set([BOX_ID]),
  };
  const manager = new PickingManager(camera, scene as never, picker as never, canvas as HTMLCanvasElement,
    () => { throw new Error('This readback fixture must not hydrate geometry'); });
  if (path === 'cpu-box-and-points') {
    manager.setPointPickProvider(() => ({
      nodes: [{ expressId: POINT_ID, chunks: [] }],
      sizing: { sizeMode: 0, worldRadius: 0.02, pointSizePx: 4 },
    }));
  }
  return {
    camera, css, canvas, submissions, manager, picker,
    begin: () => path === 'point' ? manager.pick(50, 40) : manager.pickRect(10, 10, 90, 70),
    finish: () => {
      if (path === 'point') pointReadback.resolve({ expressId: BOX_ID, modelIndex: 0 });
      else rectReadback.resolve(new Set(path === 'cpu-box-and-points' ? [POINT_ID] : [BOX_ID]));
    },
    fail: () => rectReadback.reject(new Error('delayed point readback failure')),
  };
}

type ReadbackFixture = ReturnType<typeof readbackFixture>;
const viewportChanges: Array<{ name: string; change: (h: ReadbackFixture) => void }> = [
  { name: 'a proportional resize with unchanged camera aspect', change: h => { h.css.width = 200; h.css.height = 160; } },
  { name: 'a changed texel width', change: h => { h.css.width = 200; } },
  { name: 'a changed texel height', change: h => { h.css.height = 160; } },
  { name: 'fractional CSS width with unchanged rounded texels', change: h => { h.css.width = 100.1; } },
  { name: 'fractional CSS height with unchanged rounded texels', change: h => { h.css.height = 80.1; } },
  { name: 'a collapsed viewport', change: h => { h.css.width = 0; } },
];

// #6882: begin() captures input mapping and suspends at the GPU boundary. Change
// state only AFTER that submission; release the deferred readback only AFTER
// the change. These assertions exercise the real manager's async result policy.
for (const path of ['point', 'gpu-rectangle', 'cpu-box-and-points'] as const) {
  describe(`viewport changes during ${path} readback (#6882)`, () => {
    for (const { name, change } of viewportChanges) {
      it(`rejects ${name}`, async () => {
        const h = readbackFixture(path);
        const epoch = h.camera.getRelativeToEyeFrame().getRenderEpoch();
        const pending = h.begin();
        assert.deepEqual(h.submissions, [{ width: 100, height: 80 }]);
        change(h);
        h.camera.setAspect(h.camera.getAspect());
        assert.equal(h.camera.getRelativeToEyeFrame().getRenderEpoch(), epoch,
          'viewport rejection must work independently of camera invalidation');
        h.finish();
        assert.deepEqual(await pending, path === 'point' ? null : new Set());
      });
    }

    it('accepts unchanged CSS mapping despite a different drawing buffer and redundant aspect sync', async () => {
      const h = readbackFixture(path);
      const pending = h.begin();
      assert.equal(h.submissions.length, 1);
      h.canvas.width = 100;
      h.canvas.height = 80;
      h.camera.setAspect(h.camera.getAspect());
      h.finish();
      assert.deepEqual(await pending, path === 'point' ? { expressId: BOX_ID, modelIndex: 0 }
        : new Set(path === 'cpu-box-and-points' ? [BOX_ID, POINT_ID] : [BOX_ID]));
    });

    for (const change of ['aspect', 'position'] as const) {
      it(`retains the existing stale-camera policy after a real ${change} change`, async () => {
        const h = readbackFixture(path);
        const pending = h.begin();
        assert.equal(h.submissions.length, 1);
        if (change === 'aspect') h.camera.setAspect(16 / 9);
        else { const p = h.camera.getPosition(); h.camera.setPosition(p.x + 1, p.y, p.z); }
        h.finish();
        // The existing CPU fallback retains synchronous box hits while rejecting
        // stale asynchronous point hits. Do not broaden that camera policy here.
        assert.deepEqual(await pending, path === 'point' ? null
          : new Set(path === 'cpu-box-and-points' ? [BOX_ID] : []));
      });
    }
  });
}

describe('viewport validity after a failed asynchronous point rectangle (#6882)', () => {
  for (const { name, change } of viewportChanges) {
    it(`does not return captured CPU box hits after ${name}`, async t => {
      const warning = t.mock.method(console, 'warn', () => {});
      const h = readbackFixture('cpu-box-and-points');
      const pending = h.begin();
      assert.equal(h.submissions.length, 1);
      change(h);
      h.fail();
      assert.deepEqual(await pending, new Set());
      assert.equal(warning.mock.callCount(), 1);
    });
  }

  it('retains CPU box hits on readback failure when CSS mapping remains current', async t => {
    const warning = t.mock.method(console, 'warn', () => {});
    const h = readbackFixture('cpu-box-and-points');
    const pending = h.begin();
    h.canvas.width = 100;
    h.canvas.height = 80;
    h.fail();
    assert.deepEqual(await pending, new Set([BOX_ID]));
    assert.equal(warning.mock.callCount(), 1);
  });
});

// #6881 lifecycle: completed data from an obsolete picker must not escape the
// real manager after teardown/replacement, even with identical camera/viewport.
for (const path of ['point', 'gpu-rectangle', 'cpu-box-and-points'] as const) {
  for (const transition of ['clear', 'replace', 'clear-and-restore'] as const) {
    it(`rejects ${path} after picker ${transition} (#6881 lifecycle)`, async () => {
      const h = readbackFixture(path);
      const pending = h.begin();
      assert.equal(h.submissions.length, 1);
      h.manager.setPicker(transition === 'replace' ? { ...h.picker } as never : null);
      if (transition === 'clear-and-restore') h.manager.setPicker(h.picker as never);
      h.finish();
      assert.deepEqual(await pending, path === 'point' ? null : new Set());
    });
  }
  it(`retains ${path} when the same picker is redundantly installed (#6881 lifecycle)`, async () => {
    const h = readbackFixture(path);
    const pending = h.begin();
    h.manager.setPicker(h.picker as never);
    h.finish();
    assert.deepEqual(await pending, path === 'point' ? { expressId: BOX_ID, modelIndex: 0 }
      : new Set(path === 'cpu-box-and-points' ? [BOX_ID, POINT_ID] : [BOX_ID]));
  });
}
it('rejects captured CPU box hits on failed obsolete picker (#6881 lifecycle)', async t => {
  t.mock.method(console, 'warn', () => {});
  const h = readbackFixture('cpu-box-and-points');
  const pending = h.begin();
  h.manager.setPicker(null);
  h.fail();
  assert.deepEqual(await pending, new Set());
});
