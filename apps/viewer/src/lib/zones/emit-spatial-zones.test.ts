/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The FRAME half of `IfcSpatialZone` emission (#2508 item 3).
 *
 * The schema half is tested in `@ifc-lite/create`. What only the viewer can get
 * wrong is which frame the numbers are in, and that failure is invisible in a
 * shape check: a zone placed by the wrong origin is a valid IfcSpatialZone that
 * sits somewhere else. So every assertion here is about WHERE the zone lands.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { zoneToIfcWorld } from './emit-spatial-zones.js';
import type { Zone } from './types.js';

const ZONE: Zone = {
  id: 'z-a',
  name: 'Takt A',
  // Render frame: centre 2 m up, so the base is at y = 0.
  center: [10, 2, 5],
  size: [6, 4, 8],
  rotationY: 0,
};

/** No shift at all: the identity case that isolates the axis swap. */
const NO_SHIFT = {};

describe('zoneToIfcWorld: axes', () => {
  it('swaps Y-up to Z-up, and places the BASE rather than the centre', () => {
    const out = zoneToIfcWorld(ZONE, NO_SHIFT);
    // Viewer (x=10, y=0 base, z=5) -> IFC (x=10, y=-5, z=0).
    assert.deepEqual(out.Position, [10, -5, 0]);
    // An extruded solid grows along +Z from its placement, so handing it the
    // centre would raise the zone by half its height.
    assert.equal(out.Height, 4);
  });

  it('maps the horizontal extents to the axes they became', () => {
    const out = zoneToIfcWorld(ZONE, NO_SHIFT);
    assert.equal(out.Width, 6);   // render X stays X
    assert.equal(out.Depth, 8);   // render Z becomes IFC Y
  });
});

describe('zoneToIfcWorld: the render shift', () => {
  it('adds back the wasm RTC offset, which is recorded in IFC axes', () => {
    // The RTC offset is subtracted by the wasm mesh pass and recorded Z-up,
    // unlike the origin shift. Adding the two in the same axes would fold a
    // model's north offset into its height, which is why this goes through
    // `renderToWorldViewer` rather than a hand-rolled add.
    const out = zoneToIfcWorld(ZONE, { wasmRtcOffsetIfc: { x: 1000, y: 2000, z: 3 } });
    assert.deepEqual(out.Position, [1010, 1995, 3]);
  });

  it('adds back the origin shift, which is recorded in renderer axes', () => {
    const out = zoneToIfcWorld(ZONE, { originShift: { x: 1, y: 2, z: 3 } });
    // Viewer base (11, 2, 8) -> IFC (11, -8, 2).
    assert.deepEqual(out.Position, [11, -8, 2]);
  });

  it('applies BOTH shifts, each in its own axes', () => {
    const out = zoneToIfcWorld(ZONE, {
      originShift: { x: 1, y: 2, z: 3 },
      wasmRtcOffsetIfc: { x: 100, y: 200, z: 300 },
    });
    // Worked by hand, because this is the assertion that would otherwise just
    // echo whatever the code does: base (10, 0, 5) + originShift (1, 2, 3) in
    // renderer axes + RTC (100, 200, 300) converted to renderer axes
    // (100, 300, -200) = (111, 302, -192), which swaps to (111, 192, 302).
    // A far-from-origin model is exactly the case where getting this wrong is
    // invisible on screen and catastrophic in the file.
    assert.deepEqual(out.Position, [111, 192, 302]);
  });
});

describe('zoneToIfcWorld: rotation', () => {
  it('flips the sign, because the axis swap mirrors the horizontal plane', () => {
    const out = zoneToIfcWorld({ ...ZONE, rotationY: Math.PI / 4 }, NO_SHIFT);
    assert.equal(out.RotationZ, 0 - Math.PI / 4);
  });

  it('emits no rotation for a prism, whose footprint is already world-aligned', () => {
    const out = zoneToIfcWorld(
      { ...ZONE, rotationY: 1.2, footprint: [[0, 0], [6, 0], [6, 8]] },
      NO_SHIFT,
    );
    assert.equal(out.RotationZ, 0);
  });
});

describe('zoneToIfcWorld: prisms', () => {
  it('carries the footprint through the same shift and swap as the position', () => {
    const out = zoneToIfcWorld(
      { ...ZONE, footprint: [[10, 5], [16, 5], [16, 13]] },
      { originShift: { x: 1, y: 0, z: 0 } },
    );
    assert.ok(out.Footprint);
    // Each render X/Z pair becomes an IFC X/Y pair, shifted: x + 1, y = -z.
    assert.deepEqual(out.Footprint, [[11, -5], [17, -5], [17, -13]]);
  });

  it('drops a footprint too small to be a polygon rather than emitting one', () => {
    const out = zoneToIfcWorld({ ...ZONE, footprint: [[0, 0], [1, 0]] }, NO_SHIFT);
    assert.equal(out.Footprint, undefined);
    // ...and falls back to the box extents, so the zone still has a shape.
    assert.equal(out.Width, 6);
  });
});
