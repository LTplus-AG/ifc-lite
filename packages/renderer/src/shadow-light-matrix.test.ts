/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fitSunLightMatrix, cameraFrustumFocusCorners } from './shadow-light-matrix.js';
import type { Mat4, Vec3 } from './types.js';

/** Transform a world point by a column-major Mat4, returning clip-space xyzw. */
function apply(m: Mat4, p: Vec3): [number, number, number, number] {
  const a = m.m;
  return [
    a[0] * p.x + a[4] * p.y + a[8] * p.z + a[12],
    a[1] * p.x + a[5] * p.y + a[9] * p.z + a[13],
    a[2] * p.x + a[6] * p.y + a[10] * p.z + a[14],
    a[3] * p.x + a[7] * p.y + a[11] * p.z + a[15],
  ];
}

/** NDC (perspective-divide) of a world point through a light matrix. */
function ndc(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z, w] = apply(m, p);
  return { x: x / w, y: y / w, z: z / w };
}

const UNIT_BOX = {
  boundsMin: [-1, -1, -1] as [number, number, number],
  boundsMax: [1, 1, 1] as [number, number, number],
};

describe('fitSunLightMatrix', () => {
  it('maps the whole model AABB inside the shadow clip cube', () => {
    const fit = fitSunLightMatrix({
      sunDirection: [0.4, 1, 0.3],
      ...UNIT_BOX,
    });
    // Every AABB corner must land in x,y ∈ [-1,1] and reverse-Z z ∈ [0,1].
    for (let i = 0; i < 8; i++) {
      const p: Vec3 = {
        x: (i & 1) ? 1 : -1,
        y: (i & 2) ? 1 : -1,
        z: (i & 4) ? 1 : -1,
      };
      const c = ndc(fit.lightViewProj, p);
      assert.ok(c.x >= -1.0001 && c.x <= 1.0001, `x ${c.x} out of range for corner ${i}`);
      assert.ok(c.y >= -1.0001 && c.y <= 1.0001, `y ${c.y} out of range for corner ${i}`);
      assert.ok(c.z >= -0.0001 && c.z <= 1.0001, `z ${c.z} out of range for corner ${i}`);
    }
  });

  it('uses reverse-Z: nearer-to-sun points get larger depth', () => {
    const fit = fitSunLightMatrix({ sunDirection: [0, 1, 0], ...UNIT_BOX });
    // Sun straight up: the top of the box (y=1) is nearer the sun than the
    // bottom (y=-1), so under reverse-Z its clip z must be larger.
    const top = ndc(fit.lightViewProj, { x: 0, y: 1, z: 0 });
    const bottom = ndc(fit.lightViewProj, { x: 0, y: -1, z: 0 });
    assert.ok(top.z > bottom.z, `top z ${top.z} should exceed bottom z ${bottom.z}`);
  });

  it('returns a finite matrix for a straight-overhead sun', () => {
    const fit = fitSunLightMatrix({ sunDirection: [0, 1, 0], ...UNIT_BOX });
    for (const v of fit.lightViewProj.m) assert.ok(Number.isFinite(v), 'non-finite matrix entry');
    assert.ok(fit.depthRange > 0, 'depth range must be positive');
  });

  it('falls back to a valid matrix for a zero / non-finite sun', () => {
    for (const bad of [[0, 0, 0], [Infinity, 0, 0], [NaN, 1, 0]] as const) {
      const fit = fitSunLightMatrix({ sunDirection: bad, ...UNIT_BOX });
      for (const v of fit.lightViewProj.m) {
        assert.ok(Number.isFinite(v), `non-finite entry for sun ${JSON.stringify(bad)}`);
      }
    }
  });

  it('fits a tighter lateral box to focusCorners than to whole bounds', () => {
    // A small focus region inside a large model should shrink the ortho box.
    const large = {
      boundsMin: [-100, -100, -100] as [number, number, number],
      boundsMax: [100, 100, 100] as [number, number, number],
    };
    const wide = fitSunLightMatrix({ sunDirection: [0, 1, 0], ...large });
    const focused = fitSunLightMatrix({
      sunDirection: [0, 1, 0],
      ...large,
      focusCorners: [
        { x: -1, y: -1, z: -1 }, { x: 1, y: -1, z: -1 },
        { x: -1, y: 1, z: -1 }, { x: 1, y: 1, z: -1 },
        { x: -1, y: -1, z: 1 }, { x: 1, y: -1, z: 1 },
        { x: -1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 },
      ],
    });
    assert.ok(
      focused.orthoHalfWidth < wide.orthoHalfWidth * 0.5,
      `focused half-width ${focused.orthoHalfWidth} not much smaller than ${wide.orthoHalfWidth}`,
    );
  });

  it('still encloses a far occluder in depth when focus is a thin slab', () => {
    // Focus is a thin near slab, but a tall occluder above must still be in the
    // depth range so it can cast into the focus.
    const tall = {
      boundsMin: [-1, -50, -1] as [number, number, number],
      boundsMax: [1, 50, 1] as [number, number, number],
    };
    const fit = fitSunLightMatrix({
      sunDirection: [0, 1, 0],
      ...tall,
      focusCorners: [
        { x: -1, y: -50, z: -1 }, { x: 1, y: -50, z: -1 },
        { x: -1, y: -49, z: -1 }, { x: 1, y: -49, z: -1 },
        { x: -1, y: -50, z: 1 }, { x: 1, y: -50, z: 1 },
        { x: -1, y: -49, z: 1 }, { x: 1, y: -49, z: 1 },
      ],
    });
    // The top occluder (y=50) must still fall within the clip depth [0,1].
    const topOccluder = ndc(fit.lightViewProj, { x: 0, y: 50, z: 0 });
    assert.ok(
      topOccluder.z >= -0.0001 && topOccluder.z <= 1.0001,
      `far occluder z ${topOccluder.z} left the depth range`,
    );
  });
});

describe('cameraFrustumFocusCorners', () => {
  const bigSite = {
    boundsMin: [-100, -1, -100] as [number, number, number],
    boundsMax: [100, 20, 100] as [number, number, number],
  };
  // A camera near the origin looking down -Z at the site centre.
  const cam = {
    eye: { x: 0, y: 10, z: 60 } as Vec3,
    forward: { x: 0, y: 0, z: -1 } as Vec3,
    right: { x: 1, y: 0, z: 0 } as Vec3,
    up: { x: 0, y: 1, z: 0 } as Vec3,
    fovY: (45 * Math.PI) / 180,
    aspect: 1.6,
    ortho: false,
    orthoHalfHeight: 10,
    ...bigSite,
  };

  it('returns eight corners clipped inside the model bounds', () => {
    const corners = cameraFrustumFocusCorners(cam);
    assert.ok(corners, 'expected a focus');
    assert.equal(corners!.length, 8);
    for (const c of corners!) {
      assert.ok(c.x >= bigSite.boundsMin[0] - 1e-6 && c.x <= bigSite.boundsMax[0] + 1e-6, `x ${c.x} out of bounds`);
      assert.ok(c.y >= bigSite.boundsMin[1] - 1e-6 && c.y <= bigSite.boundsMax[1] + 1e-6, `y ${c.y} out of bounds`);
      assert.ok(c.z >= bigSite.boundsMin[2] - 1e-6 && c.z <= bigSite.boundsMax[2] + 1e-6, `z ${c.z} out of bounds`);
    }
  });

  it('fits a tighter lateral box than whole bounds when zoomed in on a site', () => {
    // A narrow FOV close to the centre sees only a small patch of the site.
    const zoomed = { ...cam, eye: { x: 0, y: 5, z: 20 } as Vec3, fovY: (20 * Math.PI) / 180 };
    const focus = cameraFrustumFocusCorners(zoomed);
    const wide = fitSunLightMatrix({ sunDirection: [0.3, 1, 0.2], ...bigSite });
    const focused = fitSunLightMatrix({ sunDirection: [0.3, 1, 0.2], ...bigSite, focusCorners: focus ?? undefined });
    assert.ok(
      focused.orthoHalfWidth < wide.orthoHalfWidth * 0.8,
      `focused ${focused.orthoHalfWidth} not tighter than bounds ${wide.orthoHalfWidth}`,
    );
  });

  it('returns null when the model is entirely behind the camera', () => {
    const away = { ...cam, forward: { x: 0, y: 0, z: 1 } as Vec3, eye: { x: 0, y: 10, z: 300 } as Vec3 };
    assert.equal(cameraFrustumFocusCorners(away), null);
  });
});

