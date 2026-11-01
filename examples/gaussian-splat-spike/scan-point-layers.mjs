/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import * as pc from 'playcanvas';
import { pointResources } from './point-resources.mjs';

// Research backend ownership, shared by attempt-start clearing and teardown.
export function nativeScanPoints(points, invalidate) {
  let handle = null, count = 0;
  function clear() {
    const previous = handle;
    handle = null; count = 0;
    if (previous) points.removeAsset(previous);
    invalidate();
  }
  return {
    clear, get count() { return count; },
    replace(chunk) {
      clear();
      try {
        handle = points.beginAsset({ expressId: 1 });
        points.appendChunk(handle, chunk); points.endAsset(handle);
        count = chunk.pointCount; invalidate();
      } catch (error) { clear(); throw error; }
    },
  };
}

export function playcanvasScanPoints(device, root, invalidate) {
  const resources = pointResources(device);
  let count = 0;
  function clear() {
    count = 0;
    // Detach render instances before releasing their mesh/material owner.
    for (const child of root.children.slice()) child.destroy();
    resources.clear();
    invalidate();
  }
  return {
    clear, get count() { return count; },
    replace(chunk) {
      clear();
      try {
        const { mesh, material } = resources.replace(chunk);
        const entity = new pc.Entity(); root.addChild(entity);
        entity.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, material)] });
        count = chunk.pointCount; invalidate();
      } catch (error) { clear(); throw error; }
    },
  };
}
