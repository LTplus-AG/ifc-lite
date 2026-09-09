/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Event, Matrix4 } from 'cesium';
import { whenModelRenderable } from './cesium-model-renderable';

it('drives an idle request-render scene through readiness and the first drawn replacement frame (#4226)', async () => {
  const readyEvent = new Event(), postRender = new Event();
  let requested = false, drawn = 0, completed = false;
  const viewer = { scene: { postRender, requestRender() { requested = true; } } };
  const model = { modelMatrix: new Matrix4(), ready: false, readyEvent };
  const waiting = whenModelRenderable(viewer, model).then(() => { completed = true; });
  try {
    assert.equal(requested, true, 'the new primitive cannot update while an idle scene has no requested frame');
    requested = false;
    // Cesium Model.update raises readyEvent via Scene.afterRender, then
    // Scene.postRender runs in that SAME frame; the model draws next frame.
    model.ready = true; readyEvent.raiseEvent(); postRender.raiseEvent();
    await Promise.resolve();
    assert.equal(completed, false, 'the readiness frame must not release the predecessor');
    assert.equal(requested, true, 'request a second frame without a mouse/camera event');
    requested = false; drawn++; postRender.raiseEvent();
    await waiting;
    assert.equal(drawn, 1);
    assert.equal(completed, true);
    assert.equal(readyEvent.numberOfListeners, 0);
    assert.equal(postRender.numberOfListeners, 0);
  } finally {
    // Also drain listeners/timers if a mutation of production fails an assertion.
    model.ready = true; readyEvent.raiseEvent(); postRender.raiseEvent(); postRender.raiseEvent();
    await waiting;
  }
});

it('requests the first drawn frame for a model that was already ready (#4226)', async () => {
  const postRender = new Event(); let requested = false;
  const waiting = whenModelRenderable({ scene: { postRender, requestRender() { requested = true; } } },
    { modelMatrix: new Matrix4(), ready: true });
  try { assert.equal(requested, true); }
  finally { postRender.raiseEvent(); await waiting; }
  assert.equal(postRender.numberOfListeners, 0);
});
