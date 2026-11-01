/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import * as pc from 'playcanvas';

// The current scan has a shorter lifetime than the fixture scene (#8140).
export function pointResources(device) {
  let mesh = null, material = null;
  function clear() {
    mesh?.destroy(); material?.destroy();
    mesh = null; material = null;
  }
  return {
    clear,
    replace(chunk) {
      clear();
      try {
        mesh = new pc.Mesh(device); mesh.setPositions(chunk.positions);
        if (chunk.colors) mesh.setColors(chunk.colors, 3);
        mesh.update(pc.PRIMITIVE_POINTS, false);
        material = new pc.StandardMaterial(); material.useLighting = false;
        material.emissive.set(1, 1, 1); material.emissiveVertexColor = Boolean(chunk.colors); material.update();
        return { mesh, material };
      } catch (error) { clear(); throw error; }
    },
  };
}
