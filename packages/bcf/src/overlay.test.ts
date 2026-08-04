/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { computeMarkerPositions, type EntityBoundsLookup, type OverlayBBox } from './overlay.js';
import type { BCFTopic, BCFViewpoint } from './types.js';

const GUID_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const GUID_B = 'BBBBBBBBBBBBBBBBBBBBBB';

function topic(overrides: Partial<BCFTopic> = {}): BCFTopic {
  return {
    guid: `topic-${Math.random().toString(36).slice(2)}`,
    title: 'T',
    creationDate: '2026-01-01T00:00:00.000Z',
    creationAuthor: 'a@example.com',
    comments: [],
    viewpoints: [],
    ...overrides,
  };
}

/** A viewpoint whose camera sits at the BCF origin looking along +Y (BCF forward). */
function cameraViewpoint(direction = { x: 0, y: 1, z: 0 }): BCFViewpoint {
  return {
    guid: 'vp-cam',
    perspectiveCamera: {
      cameraViewPoint: { x: 1, y: 2, z: 3 },
      cameraDirection: direction,
      cameraUpVector: { x: 0, y: 0, z: 1 },
      fieldOfView: 60,
    },
  };
}

const noBounds: EntityBoundsLookup = () => null;

describe('computeMarkerPositions', () => {
  const bbox: OverlayBBox = { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 10, z: 6 } };
  const boundsFor = (guid: string): EntityBoundsLookup => (g) => (g === guid ? bbox : null);

  it('floats a component marker above the bbox top and anchors the connector on it', () => {
    // The lift is 30% of the element height with a 0.5 m floor. Without it the
    // marker sits exactly on the bbox top and z-fights the geometry it labels.
    const t = topic({ viewpoints: [{ guid: 'vp', components: { selection: [{ ifcGuid: GUID_A }] } }] });
    const [marker] = computeMarkerPositions([t], boundsFor(GUID_A));

    expect(marker.positionSource).toBe('component');
    // Centre in X/Z, top + 30% of a 10 m height.
    expect(marker.connectorAnchor).toEqual({ x: 2, y: 10, z: 3 });
    expect(marker.position).toEqual({ x: 2, y: 13, z: 3 });
  });

  it('applies the 0.5 m minimum lift to a zero-height element', () => {
    // A flat element (a slab face, a 2D annotation) has height 0, so the
    // percentage lift collapses; the floor is what keeps the marker visible.
    const flat: OverlayBBox = { min: { x: 0, y: 5, z: 0 }, max: { x: 2, y: 5, z: 2 } };
    const t = topic({ viewpoints: [{ guid: 'vp', components: { selection: [{ ifcGuid: GUID_A }] } }] });
    const [marker] = computeMarkerPositions([t], (g) => (g === GUID_A ? flat : null));

    expect(marker.connectorAnchor!.y).toBe(5);
    expect(marker.position.y).toBe(5.5);
  });

  it('falls back through camera-target to camera-position when no component resolves', () => {
    // Strategy 2: BCF direction {0,1,0} is Y-up {0,0,-1}, so the target is
    // targetDistance units along -Z from the (converted) camera position.
    const withDirection = topic({ viewpoints: [cameraViewpoint()] });
    const [target] = computeMarkerPositions([withDirection], noBounds, { targetDistance: 10 });
    expect(target.positionSource).toBe('camera-target');
    expect(target.position).toEqual({ x: 1, y: 3, z: -12 });
    expect(target.connectorAnchor).toBeUndefined();

    // Strategy 3: a degenerate (zero-length) direction has no derivable target,
    // so the marker falls back to the camera position itself.
    const degenerate = topic({ viewpoints: [cameraViewpoint({ x: 0, y: 0, z: 0 })] });
    const [position] = computeMarkerPositions([degenerate], noBounds, { targetDistance: 10 });
    expect(position.positionSource).toBe('camera-position');
    expect(position.position).toEqual({ x: 1, y: 3, z: -2 });
  });

  it('prefers a resolvable component over the camera, and skips unresolvable ones', () => {
    // The first selected component has no geometry loaded; the second does. The
    // loop must keep looking rather than giving up and falling back to a camera.
    const t = topic({
      viewpoints: [
        {
          guid: 'vp',
          components: { selection: [{ ifcGuid: GUID_B }, { ifcGuid: GUID_A }] },
          perspectiveCamera: cameraViewpoint().perspectiveCamera,
        },
      ],
    });
    const [marker] = computeMarkerPositions([t], boundsFor(GUID_A));
    expect(marker.positionSource).toBe('component');
    expect(marker.position).toEqual({ x: 2, y: 13, z: 3 });
  });

  it('uses isolation exceptions as component anchors only when defaultVisibility is false', () => {
    const isolation = topic({
      viewpoints: [{
        guid: 'vp',
        components: { visibility: { defaultVisibility: false, exceptions: [{ ifcGuid: GUID_A }] } },
        perspectiveCamera: cameraViewpoint().perspectiveCamera,
      }],
    });
    expect(computeMarkerPositions([isolation], boundsFor(GUID_A))[0].positionSource).toBe('component');

    // The same exceptions with defaultVisibility=true are a HIDE list — anchoring
    // the marker to a hidden element would point at nothing.
    const hiding = topic({
      viewpoints: [{
        guid: 'vp',
        components: { visibility: { defaultVisibility: true, exceptions: [{ ifcGuid: GUID_A }] } },
        perspectiveCamera: cameraViewpoint().perspectiveCamera,
      }],
    });
    expect(computeMarkerPositions([hiding], boundsFor(GUID_A))[0].positionSource).toBe('camera-target');
  });

  it('keeps matching statuses and drops non-matching ones, case-insensitively', () => {
    // Both directions of the filter: an inverted comparison would pass a test
    // that only ever checked one of them.
    const open = topic({ topicStatus: 'Open', viewpoints: [cameraViewpoint()] });
    const closed = topic({ topicStatus: 'Closed', viewpoints: [cameraViewpoint()] });

    const kept = computeMarkerPositions([open, closed], noBounds, { statusFilter: ['open'] });
    expect(kept.map((m) => m.topicGuid)).toEqual([open.guid]);

    const inverse = computeMarkerPositions([open, closed], noBounds, { statusFilter: ['CLOSED'] });
    expect(inverse.map((m) => m.topicGuid)).toEqual([closed.guid]);

    // An empty filter is "no filter", not "match nothing".
    expect(computeMarkerPositions([open, closed], noBounds, { statusFilter: [] })).toHaveLength(2);
  });

  it('numbers markers from 1 when the topic carries no index', () => {
    // Marker labels are user-facing; a 0-based fallback would show "0" on the
    // first pin. An explicit topic index still wins.
    const a = topic({ viewpoints: [cameraViewpoint()] });
    const b = topic({ viewpoints: [cameraViewpoint()] });
    const c = topic({ index: 42, viewpoints: [cameraViewpoint()] });

    expect(computeMarkerPositions([a, b, c], noBounds).map((m) => m.index)).toEqual([1, 2, 42]);
  });

  it('skips topics with no derivable position and defaults the display fields', () => {
    const positionless = topic({ viewpoints: [{ guid: 'vp-empty' }] });
    const noViewpoints = topic();
    const ok = topic({ viewpoints: [cameraViewpoint()], comments: [
      { guid: 'c1', date: '2026-01-01T00:00:00.000Z', author: 'a@example.com', comment: 'x' },
    ] });

    const markers = computeMarkerPositions([positionless, noViewpoints, ok], noBounds);
    expect(markers.map((m) => m.topicGuid)).toEqual([ok.guid]);
    expect(markers[0]).toMatchObject({
      status: 'Open',
      priority: 'Normal',
      topicType: 'Issue',
      commentCount: 1,
      hasViewpoint: true,
    });
  });
});
