/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `translateViewpoint` moves a viewpoint between a viewer's shifted render
 * frame and IFC world coordinates (#4806). Positions move, directions do not.
 */

import { describe, it, expect } from 'vitest';
import { translateViewpoint, viewpointFromWorld } from './viewpoint-frame.js';
import type { BCFViewpoint } from './types.js';

/** Roughly where the #4806 reporter's georeferenced model sits. */
const OFFSET = { x: 41266, y: 308208, z: 123 };

function localViewpoint(): BCFViewpoint {
  return {
    guid: 'vp',
    perspectiveCamera: {
      cameraViewPoint: { x: 10, y: -20, z: 5 },
      cameraDirection: { x: 0, y: 1, z: 0 },
      cameraUpVector: { x: 0, y: 0, z: 1 },
      fieldOfView: 60,
      aspectRatio: 1.5,
    },
    orthogonalCamera: {
      cameraViewPoint: { x: 1, y: 2, z: 3 },
      cameraDirection: { x: 1, y: 0, z: 0 },
      cameraUpVector: { x: 0, y: 0, z: 1 },
      viewToWorldScale: 12,
    },
    clippingPlanes: [{ location: { x: 0, y: 0, z: 3 }, direction: { x: 0, y: 0, z: -1 } }],
    lines: [{ startPoint: { x: 0, y: 0, z: 0 }, endPoint: { x: 1, y: 1, z: 1 } }],
    bitmaps: [{
      format: 'PNG', reference: 'b.png', location: { x: 2, y: 2, z: 2 },
      normal: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 }, height: 1,
    }],
    components: { selection: [{ ifcGuid: 'A' }] },
  };
}

describe('translateViewpoint (#4806)', () => {
  it('moves every position by the offset and leaves directions alone', () => {
    const world = translateViewpoint(localViewpoint(), OFFSET);
    expect(world.perspectiveCamera?.cameraViewPoint).toEqual({ x: 41276, y: 308188, z: 128 });
    expect(world.perspectiveCamera?.cameraDirection).toEqual({ x: 0, y: 1, z: 0 });
    expect(world.perspectiveCamera?.fieldOfView).toBe(60);
    expect(world.perspectiveCamera?.aspectRatio).toBe(1.5);
    expect(world.orthogonalCamera?.cameraViewPoint).toEqual({ x: 41267, y: 308210, z: 126 });
    expect(world.orthogonalCamera?.viewToWorldScale).toBe(12);
    expect(world.clippingPlanes?.[0]).toEqual({ location: { x: 41266, y: 308208, z: 126 }, direction: { x: 0, y: 0, z: -1 } });
    expect(world.lines?.[0]).toEqual({ startPoint: OFFSET, endPoint: { x: 41267, y: 308209, z: 124 } });
    expect(world.bitmaps?.[0].location).toEqual({ x: 41268, y: 308210, z: 125 });
    expect(world.bitmaps?.[0].normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(world.components).toEqual({ selection: [{ ifcGuid: 'A' }] });
  });

  it('round-trips with the negated offset and does not mutate its input', () => {
    const local = localViewpoint();
    const back = translateViewpoint(
      translateViewpoint(local, OFFSET),
      { x: -OFFSET.x, y: -OFFSET.y, z: -OFFSET.z },
    );
    expect(back).toEqual(localViewpoint());
    expect(local).toEqual(localViewpoint());
  });

  it('is the identity for a zero offset', () => {
    const local = localViewpoint();
    expect(translateViewpoint(local, { x: 0, y: 0, z: 0 })).toBe(local);
  });
});

describe('viewpointFromWorld (#4879)', () => {
  /** Y-up render-frame bounds of a model drawn near the origin. */
  const RENDER_BOUNDS = { min: { x: -20, y: 0, z: -20 }, max: { x: 20, y: 10, z: 20 } };

  it('moves a world viewpoint back into the render frame: camera and clipping plane', () => {
    const world = translateViewpoint(localViewpoint(), OFFSET);
    const local = viewpointFromWorld(world, OFFSET, RENDER_BOUNDS);
    expect(local.perspectiveCamera?.cameraViewPoint).toEqual({ x: 10, y: -20, z: 5 });
    expect(local.clippingPlanes?.[0].location).toEqual({ x: 0, y: 0, z: 3 });
    expect(local.perspectiveCamera?.cameraDirection).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('reads a world viewpoint as world when there are no bounds to compare against', () => {
    const world = translateViewpoint(localViewpoint(), OFFSET);
    expect(viewpointFromWorld(world, OFFSET).perspectiveCamera?.cameraViewPoint).toEqual({ x: 10, y: -20, z: 5 });
  });

  it('keeps a pre-#4806 render-frame viewpoint where it is', () => {
    const legacy = localViewpoint();
    expect(viewpointFromWorld(legacy, OFFSET, RENDER_BOUNDS)).toBe(legacy);
  });

  it('is the identity for a zero offset', () => {
    const world = localViewpoint();
    expect(viewpointFromWorld(world, { x: 0, y: 0, z: 0 }, RENDER_BOUNDS)).toBe(world);
  });
});
