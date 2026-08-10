/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  viewerToIfcAxes,
  ifcToViewerAxes,
  renderToWorldViewer,
  pointCoordinates,
  relativeOffset,
  formatCoordinateTriple,
} from './coordinates.js';

describe('axis conversion', () => {
  it('maps the viewer UP axis to IFC Z, not to IFC Y', () => {
    // The whole risk: viewer Y is up, IFC Z is up. A point 10m above the
    // origin must come out as Z=10. Passing the axes straight through would
    // report it as Y=10 — a building's height filed under its northing.
    assert.deepStrictEqual(
      viewerToIfcAxes({ x: 0, y: 10, z: 0 }),
      { x: 0, y: 0, z: 10 },
    );
  });

  it('negates viewer Z when producing IFC Y', () => {
    // Dropping the negation mirrors the model about its north axis: the
    // numbers stay plausible and point the wrong way, which is the failure
    // mode nobody notices.
    assert.deepStrictEqual(
      viewerToIfcAxes({ x: 0, y: 0, z: 7 }),
      { x: 0, y: -7, z: 0 },
    );
  });

  it('leaves X alone', () => {
    assert.deepStrictEqual(viewerToIfcAxes({ x: 4, y: 0, z: 0 }), { x: 4, y: 0, z: 0 });
  });

  it('never emits negative zero from the negated axis', () => {
    // Unary minus on 0 yields -0, which is not a coordinate anybody authored
    // and which survives into equality checks and serialised output. Both
    // directions negate one axis, so both can produce it.
    assert.ok(!Object.is(viewerToIfcAxes({ x: 0, y: 0, z: 0 }).y, -0));
    assert.ok(!Object.is(ifcToViewerAxes({ x: 0, y: 0, z: 0 }).z, -0));
  });

  it('round-trips through the inverse in both directions', () => {
    const viewer = { x: 1.5, y: -2.25, z: 3.75 };
    assert.deepStrictEqual(ifcToViewerAxes(viewerToIfcAxes(viewer)), viewer);
    const ifc = { x: -9, y: 4.5, z: 0.25 };
    assert.deepStrictEqual(viewerToIfcAxes(ifcToViewerAxes(ifc)), ifc);
  });
});

describe('renderToWorldViewer', () => {
  it('is the identity when neither shift was applied', () => {
    const p = { x: 1, y: 2, z: 3 };
    assert.deepStrictEqual(renderToWorldViewer(p, {}), p);
    assert.deepStrictEqual(
      renderToWorldViewer(p, { originShift: null, wasmRtcOffsetIfc: null }),
      p,
    );
  });

  it('ADDS the centroid shift back, rather than subtracting it again', () => {
    // originShift records what was taken off on import; the world position is
    // recovered by putting it back. Subtracting would double the error.
    const world = renderToWorldViewer(
      { x: 1, y: 2, z: 3 },
      { originShift: { x: 10, y: 20, z: 30 } },
    );
    assert.deepStrictEqual(world, { x: 11, y: 22, z: 33 });
  });

  it('converts the RTC offset out of IFC axes before adding it', () => {
    // wasmRtcOffset is recorded in IFC (Z-up) axes while originShift is in
    // viewer axes. An RTC offset of IFC (0, 100, 0) is a NORTHING, so it must
    // land on viewer Z (negated) — not on viewer Y, which would raise the
    // whole model 100m into the air.
    const world = renderToWorldViewer(
      { x: 0, y: 0, z: 0 },
      { wasmRtcOffsetIfc: { x: 0, y: 100, z: 0 } },
    );
    assert.deepStrictEqual(world, { x: 0, y: 0, z: -100 });
  });

  it('puts an IFC-Z RTC offset on the viewer UP axis', () => {
    const world = renderToWorldViewer(
      { x: 0, y: 0, z: 0 },
      { wasmRtcOffsetIfc: { x: 0, y: 0, z: 100 } },
    );
    assert.deepStrictEqual(world, { x: 0, y: 100, z: 0 });
  });

  it('applies both offsets together', () => {
    const world = renderToWorldViewer(
      { x: 1, y: 1, z: 1 },
      {
        originShift: { x: 10, y: 20, z: 30 },
        wasmRtcOffsetIfc: { x: 100, y: 200, z: 300 },
      },
    );
    // viewer-space RTC = (100, 300, -200); plus shift (10, 20, 30); plus point.
    assert.deepStrictEqual(world, { x: 111, y: 321, z: -169 });
  });
});

describe('pointCoordinates', () => {
  it('reports local and world in IFC axes, and flags that they differ', () => {
    const c = pointCoordinates({ x: 1, y: 2, z: 3 }, { originShift: { x: 10, y: 0, z: 0 } });
    // local: viewer (1,2,3) -> IFC (1, -3, 2)
    assert.deepStrictEqual(c.local, { x: 1, y: -3, z: 2 });
    // world: viewer (11,2,3) -> IFC (11, -3, 2)
    assert.deepStrictEqual(c.world, { x: 11, y: -3, z: 2 });
    assert.strictEqual(c.shifted, true);
  });

  it('reports shifted=false when the model was never moved', () => {
    // A model authored near the origin has local === world, and the UI leans
    // on this to avoid printing the same row twice under two different labels.
    const c = pointCoordinates({ x: 1, y: 2, z: 3 }, {});
    assert.strictEqual(c.shifted, false);
    assert.deepStrictEqual(c.local, c.world);
  });

  it('reports shifted=false for an explicitly zero shift', () => {
    const c = pointCoordinates(
      { x: 1, y: 2, z: 3 },
      { originShift: { x: 0, y: 0, z: 0 }, wasmRtcOffsetIfc: { x: 0, y: 0, z: 0 } },
    );
    assert.strictEqual(c.shifted, false);
  });
});

describe('relativeOffset', () => {
  it('subtracts the reference from the point, not the other way round', () => {
    // A point 5m EAST of the reference must read +5, not -5.
    const r = relativeOffset({ x: 15, y: 3, z: 1 }, { x: 10, y: 3, z: 1 });
    assert.strictEqual(r.dx, 5);
    assert.strictEqual(r.dy, 0);
    assert.strictEqual(r.dz, 0);
  });

  it('reports a non-negative straight-line distance regardless of direction', () => {
    const forward = relativeOffset({ x: 3, y: 4, z: 12 }, { x: 0, y: 0, z: 0 });
    const back = relativeOffset({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 12 });
    assert.strictEqual(forward.distance, 13);
    assert.strictEqual(back.distance, 13);
    assert.strictEqual(back.dx, -3);
  });

  it('is all zeroes against itself', () => {
    const r = relativeOffset({ x: 2, y: 3, z: 4 }, { x: 2, y: 3, z: 4 });
    assert.deepStrictEqual(r, { dx: 0, dy: 0, dz: 0, distance: 0 });
  });
});

describe('formatCoordinateTriple', () => {
  it('labels each axis and pads to millimetre precision', () => {
    assert.strictEqual(
      formatCoordinateTriple({ x: 12.5, y: -3.25, z: 0 }),
      'X 12.500  Y -3.250  Z 0.000',
    );
  });

  it('honours a caller-chosen precision', () => {
    assert.strictEqual(
      formatCoordinateTriple({ x: 1.23456, y: 0, z: 0 }, 1),
      'X 1.2  Y 0.0  Z 0.0',
    );
  });
});
