/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as Cesium from 'cesium';
import { createCesiumModelOwner } from './cesium-model-owner';
import { swapCesiumModel } from '@/lib/geo/cesium-model-swap';

function lifetime() {
  let retired = false;
  const listeners = new Set<() => void>();
  return {
    isRetired: () => retired,
    onRetire(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); },
    retire() { retired = true; for (const cb of listeners) cb(); },
  };
}

it('native owner preserves opaque casting, glazing reception and exact child disposal (#7562)', () => {
  const parent = new Cesium.PrimitiveCollection();
  const owner = createCesiumModelOwner(Cesium, Cesium.Matrix4.IDENTITY);
  const releases = [0, 0];
  const children = releases.map((_, i) => ({ modelMatrix: new Cesium.Matrix4(), shadows: Cesium.ShadowMode.DISABLED, destroy() { releases[i]++; } }));
  owner.addModel(children[0], true);
  owner.addModel(children[1], false);
  parent.add(owner);
  owner.shadows = Cesium.ShadowMode.ENABLED;
  assert.deepEqual(children.map((p) => p.shadows), [Cesium.ShadowMode.ENABLED, Cesium.ShadowMode.RECEIVE_ONLY]);
  const moved = Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(1, 2, 3));
  owner.modelMatrix = moved;
  assert.ok(children.every((p) => p.modelMatrix === moved), 'both halves retain one model placement');
  owner.shadows = Cesium.ShadowMode.DISABLED;
  assert.deepEqual(children.map((p) => p.shadows), [Cesium.ShadowMode.DISABLED, Cesium.ShadowMode.DISABLED]);
  assert.equal(parent.remove(owner), true);
  assert.deepEqual(releases, [1, 1], 'native parent removal releases each part exactly once');
  parent.destroy();
  assert.deepEqual(releases, [1, 1], 'parent retirement cannot double-release the removed owner');
});

it('does not release a drawable predecessor until BOTH replacement children draw (#7562)', async () => {
  const owner = createCesiumModelOwner(Cesium, Cesium.Matrix4.IDENTITY);
  const children = [0, 1].map(() => ({ modelMatrix: new Cesium.Matrix4(), ready: false, readyEvent: new Cesium.Event(), destroy() {} }));
  for (const [i, child] of children.entries()) owner.addModel(child, i === 0);
  const postRender = new Cesium.Event();
  const cancel = lifetime();
  const parent = new Cesium.PrimitiveCollection();
  const previous = createCesiumModelOwner(Cesium, Cesium.Matrix4.IDENTITY);
  let previousReleased = 0;
  previous.addModel({ modelMatrix: new Cesium.Matrix4(), destroy() { previousReleased++; } }, true);
  parent.add(previous);
  let completed = false;
  const waiting = swapCesiumModel(parent, previous, owner,
    () => owner.whenRenderable({ scene: { postRender, requestRender() {} } }, cancel),
    () => cancel.isRetired(),
  ).then(() => { completed = true; });
  try {
    children[0].ready = true; children[0].readyEvent.raiseEvent(); postRender.raiseEvent(); postRender.raiseEvent();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, false, 'opaque readiness alone cannot swap away the complete predecessor');
    assert.equal(parent.length, 2);
    assert.equal(previousReleased, 0, 'native predecessor stays drawable while glazing is loading');
    children[1].ready = true; children[1].readyEvent.raiseEvent(); postRender.raiseEvent();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, false, 'glazing readiness event precedes its first drawn frame');
    postRender.raiseEvent(); await waiting;
    assert.equal(completed, true);
    assert.equal(parent.length, 1);
    assert.equal(parent.get(0), owner);
    assert.equal(previousReleased, 1);
    assert.equal(postRender.numberOfListeners, 0);
  } finally {
    cancel.retire();
    await waiting.catch((error: unknown) => { if (!(error instanceof Error) || !error.message.includes('cancelled')) throw error; });
    parent.destroy();
  }
});

it('retiring the viewer cancels BOTH pending readiness waits and their listeners (#7562)', async () => {
  const owner = createCesiumModelOwner(Cesium, Cesium.Matrix4.IDENTITY);
  const children = [0, 1].map(() => ({ modelMatrix: new Cesium.Matrix4(), ready: false, readyEvent: new Cesium.Event(), destroy() {} }));
  for (const child of children) owner.addModel(child, true);
  const postRender = new Cesium.Event(); const cancel = lifetime();
  const rejected = assert.rejects(owner.whenRenderable({ scene: { postRender, requestRender() {} } }, cancel), /cancelled/);
  cancel.retire(); await rejected;
  assert.ok(children.every((p) => p.readyEvent.numberOfListeners === 0));
  assert.equal(postRender.numberOfListeners, 0);
  owner.destroy?.();
});
