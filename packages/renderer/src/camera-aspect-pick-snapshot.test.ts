/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Camera } from './camera.js';
import { capturePointRteSnapshot, isPointRteSnapshotCurrent } from './pick-rte-snapshot.js';

// #6882: GPU picking holds this production snapshot across its asynchronous
// readback. Its validity must follow camera changes, not redundant viewport syncs.
for (const mode of ['perspective', 'orthographic'] as const) {
  describe(`queued pick snapshot during aspect updates (${mode}, #6882)`, () => {
    function cameraAtViewport(): Camera {
      const camera = new Camera();
      camera.setProjectionMode(mode);
      camera.setAspect(2584 / 2093);
      return camera;
    }

    it('keeps a queued snapshot valid through redundant and invalid aspect updates', () => {
      const camera = cameraAtViewport();
      const snapshot = capturePointRteSnapshot(camera);
      assert.ok(snapshot);
      const projection = camera.getProjMatrix();
      const aspect = camera.getAspect();

      camera.setAspect(aspect);
      assert.equal(isPointRteSnapshotCurrent(camera, snapshot), true,
        'the same viewport ratio must not cancel an in-flight GPU pick');
      for (const invalid of [NaN, Infinity, -Infinity, 0, -1]) {
        camera.setAspect(invalid);
        assert.equal(isPointRteSnapshotCurrent(camera, snapshot), true,
          'a rejected aspect must leave the queued snapshot valid');
      }
      assert.deepEqual(camera.getProjMatrix(), projection);
      assert.deepEqual(camera.getRelativeToEyeFrame().getViewProjection(), snapshot.getViewProjection());
    });

    it('rejects the queued snapshot after a real aspect change without moving the camera', () => {
      const camera = cameraAtViewport();
      const snapshot = capturePointRteSnapshot(camera);
      assert.ok(snapshot);
      const position = camera.getPosition();
      const target = camera.getTarget();
      const projection = camera.getProjMatrix();

      camera.setAspect(16 / 9);
      assert.equal(isPointRteSnapshotCurrent(camera, snapshot), false);
      assert.notDeepEqual(camera.getProjMatrix(), projection);
      assert.deepEqual(camera.getPosition(), position);
      assert.deepEqual(camera.getTarget(), target);
      camera.setAspect(camera.getAspect());
      assert.equal(isPointRteSnapshotCurrent(camera, snapshot), false,
        'a redundant update must not revive an already stale readback');
    });

    it('does not treat a distinct nearby aspect as an unchanged ratio', () => {
      const camera = cameraAtViewport();
      const snapshot = capturePointRteSnapshot(camera);
      assert.ok(snapshot);
      const changedAspect = camera.getAspect() + Number.EPSILON;
      assert.notEqual(changedAspect, camera.getAspect());
      camera.setAspect(changedAspect);
      assert.equal(isPointRteSnapshotCurrent(camera, snapshot), false);
    });

    it('still rejects queued readbacks after camera movement', () => {
      const camera = cameraAtViewport();
      const snapshot = capturePointRteSnapshot(camera);
      assert.ok(snapshot);
      camera.setAspect(camera.getAspect());
      const position = camera.getPosition();
      camera.setPosition(position.x + 1, position.y, position.z);
      assert.equal(isPointRteSnapshotCurrent(camera, snapshot), false);
    });

    it('preserves intentional invalidation when unchanged scene bounds are republished', () => {
      const camera = cameraAtViewport();
      const bounds = { min: { x: -10, y: -10, z: -10 }, max: { x: 10, y: 10, z: 10 } };
      camera.setSceneBounds(bounds);
      const snapshot = capturePointRteSnapshot(camera);
      assert.ok(snapshot);
      camera.setAspect(camera.getAspect());
      camera.setSceneBounds(bounds);
      assert.equal(isPointRteSnapshotCurrent(camera, snapshot), false,
        'scene invalidation remains independent of redundant aspect updates');
    });
  });
}
