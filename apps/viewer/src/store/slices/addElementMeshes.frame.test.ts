/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `addElementMeshes` had no test of any kind (#2802 lists it among the slices
 * no fixture reaches). What it does is convert IFC storey-local coordinates
 * into the renderer's frame:
 *
 *   renderer.x =  ifc.x
 *   renderer.y =  ifc.z + storeyElevation
 *   renderer.z = -ifc.y
 *
 * Three of the four ways that can break — swapping the two mapped axes,
 * dropping the negation, dropping the elevation — are INVISIBLE to a fixture
 * built from convenient numbers. A preview at the origin, on a storey at
 * elevation 0, with a square footprint, maps to itself under all of them.
 *
 * So every number below is deliberately distinct and non-zero, and the
 * assertions are on the renderer-frame extent rather than on vertex count.
 * A preview in the wrong place is the defect; a preview with the right number
 * of vertices in the wrong place is the same defect.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildElementMesh } from './addElementMeshes.js';

/** Renderer-frame bounding box of a built mesh. */
function extent(positions: Float32Array) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], positions[i + a]);
      hi[a] = Math.max(hi[a], positions[i + a]);
    }
  }
  return { lo, hi };
}

const near = (got: number, want: number, what: string) =>
  assert.ok(Math.abs(got - want) < 1e-5, `${what}: expected ${want}, got ${got}`);

describe('addElementMeshes: IFC storey-local to renderer frame (#2802)', () => {
  it('maps a column onto the axes the renderer expects', () => {
    // Distinct on every axis, none zero, and Width !== Depth so an X/Y size
    // swap moves the box too.
    const STOREY_ELEVATION = 11;
    const mesh = buildElementMesh({
      type: 'column',
      globalId: 4242,
      storeyElevation: STOREY_ELEVATION,
      payload: {
        type: 'column',
        params: { Width: 1, Depth: 0.4, Height: 5 },
        position: [3, 7, 2],
      },
    });
    assert.ok(mesh, 'a well-formed column must build');

    const { lo, hi } = extent(mesh.positions);

    // x is carried straight through: 3 +/- Width/2.
    near(lo[0], 2.5, 'min x');
    near(hi[0], 3.5, 'max x');

    // y is IFC z PLUS the storey elevation. Both halves matter: without the
    // elevation this is [2, 7], which is a preview 11 m below the floor the
    // user is standing on.
    near(lo[1], 2 + STOREY_ELEVATION, 'min y (ifc z + elevation)');
    near(hi[1], 2 + 5 + STOREY_ELEVATION, 'max y');

    // z is NEGATED ifc y. Positive 7 becomes negative, +/- Depth/2. Drop the
    // sign and the column appears mirrored across the model.
    near(lo[2], -7.2, 'min z (negated ifc y)');
    near(hi[2], -6.8, 'max z');

    // A guard on the FIXTURE, not on the code: given the four assertions above
    // pass, these spans are forced, so this cannot fail today. It exists to red
    // a future edit that makes two dimensions equal while updating the
    // expectations to match — which would leave the file passing and blind to
    // an axis swap again, the failure this whole file is about.
    const spans = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    assert.equal(
      new Set(spans.map((s) => s.toFixed(4))).size,
      3,
      `the fixture must not be symmetric on any pair of axes, got spans ${spans}`
    );
  });

  it('maps normals through the same frame change as positions', () => {
    // A normal that is not rotated with its geometry lights the preview from
    // the wrong side, which reads as a material bug rather than a frame bug.
    // The bottom face is IFC [0, 0, -1], so renderer [0, -1, 0].
    const mesh = buildElementMesh({
      type: 'column',
      globalId: 1,
      storeyElevation: 0,
      payload: { type: 'column', params: { Width: 1, Depth: 2, Height: 3 }, position: [0, 0, 0] },
    });
    assert.ok(mesh);
    const n = mesh.normals;
    near(n[0], 0, 'bottom normal x');
    near(n[1], -1, 'bottom normal y (IFC -Z becomes renderer -Y)');
    near(n[2], 0, 'bottom normal z');

    // The bottom face is [0, 0, -1] in IFC, so its x and y are BOTH zero and
    // it cannot see the `-face.normal[1]` term at all: flip that sign and the
    // assertions above still pass. Vertices 8..11 are the first side face, so
    // that is the component which discriminates.
    //
    // That face is corners [0, 4, 5, 1], all four of which sit at y = -Depth/2,
    // so it is the -Y face of the box and its OUTWARD IFC normal is [0, -1, 0],
    // mapping to renderer [0, 0, +1].
    //
    // This assertion previously read `-1`, pinning [0, +1, 0] — the INWARD
    // direction. It passed because the side normals were inward at the time,
    // which is the defect #3039 fixed by orienting each face away from the box
    // centre. So the expectation was pinned to behaviour that was wrong, and
    // #3058 and #3039 were each green alone and red together. Computed rather
    // than re-derived by eye: box centre (0, 0, 1.5), face centre (0, -1, 1.5),
    // difference (0, -1, 0).
    near(n[24], 0, 'side normal x');
    near(n[25], 0, 'side normal y');
    near(n[26], 1, 'side normal z (IFC -Y becomes renderer +Z)');

    // Every normal is unit length, so none was left un-normalised by the swap.
    // Note this alone cannot see a sign flip, which is why the component
    // assertions above exist.
    for (let i = 0; i < n.length; i += 3) {
      const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
      assert.ok(Math.abs(len - 1) < 1e-4, `normal ${i / 3} has length ${len}`);
    }
  });

  it('maps the polygon path too, which transcribes the frame change separately', () => {
    // `buildPolygonExtrusion` does not share `buildBoxFromIfcCorners`. It
    // carries its OWN copy of `(x, z + elevation, -y)`, so the three tests
    // above pin none of it: dropping the elevation or the negation there fails
    // nothing they assert.
    //
    // That matters beyond symmetry with the box path. Of the two production
    // callers, `useSpaceGhostPreview` builds ONLY `type: 'space'` payloads, so
    // one entire caller exercises exclusively the copy the box tests miss.
    //
    // Two transcriptions of one rule with no gate is the shape this repo keeps
    // getting caught by. Pinning both is the cheap half; collapsing them to one
    // is the real fix and belongs in a change that touches production code.
    const STOREY_ELEVATION = 4;
    const HEIGHT = 0.3;
    // `space`, not `slab`, because the caller this test cites builds only
    // `space` payloads — and the two take DIFFERENT lines in the dispatch
    // (`params.Height` versus `params.Thickness`), so covering slab would have
    // left the cited path unpinned while claiming to cover it.
    //
    // A triangle, asymmetric on both axes, clear of the origin, and with a
    // DISTINCT z per corner: the extrusion takes its base from corner[0] and
    // flattens the rest onto that plane, which a footprint at one z cannot
    // tell apart from per-corner z or from any other corner's.
    const mesh = buildElementMesh({
      type: 'space',
      globalId: 77,
      storeyElevation: STOREY_ELEVATION,
      payload: {
        type: 'space',
        params: { Width: 6, Depth: 4, Height: HEIGHT },
        corners: [
          [2, 5, 1],
          [8, 5, 3],
          [2, 9, 7],
        ],
      },
    });
    assert.ok(mesh, 'a well-formed space must build');

    const { lo, hi } = extent(mesh.positions);
    near(lo[0], 2, 'min x');
    near(hi[0], 8, 'max x');
    // baseZ is corner[0]'s z (1) and ONLY corner[0]'s. With corners at z 1, 3
    // and 7, reading the last corner or reading per-corner z both put max y at
    // 11.3 instead of 5.3.
    near(lo[1], 1 + STOREY_ELEVATION, 'min y (corner[0] ifc z + elevation)');
    near(hi[1], 1 + HEIGHT + STOREY_ELEVATION, 'max y');
    // Negated, so ifc y of 5..9 becomes renderer z of -9..-5.
    near(lo[2], -9, 'min z (negated ifc y)');
    near(hi[2], -5, 'max z');
  });

  it('rejects a zero-height space rather than emitting a flat volume', () => {
    // Valid-but-falsy: `Height: 0` from the panel is a number, passes any
    // truthiness check, and produces a zero-volume preview. The guard exists;
    // nothing reached it.
    const flat = buildElementMesh({
      type: 'space',
      globalId: 5,
      storeyElevation: 0,
      payload: {
        type: 'space',
        params: { Width: 1, Depth: 1, Height: 0 },
        corners: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      },
    });
    assert.equal(flat, null, 'a zero-height space must not preview');
  });

  it('builds a sloped beam across its axis, honouring both endpoint heights', () => {
    // `buildLinearBox` had no positive coverage at all. Its frame mapping is
    // the shared, tested one, but everything it does BEFORE that was unpinned:
    // the perpendicular offset, both endpoints' Z, and which param becomes the
    // thickness. All three survive mutation without this.
    const mesh = buildElementMesh({
      type: 'beam',
      globalId: 3,
      storeyElevation: 0,
      payload: {
        type: 'beam',
        params: { Width: 0.3, Height: 1 },
        start: [1, 2, 0],
        end: [5, 2, 2], // sloped: end is 2 m higher than start
      },
    });
    assert.ok(mesh, 'a well-formed beam must build');
    const { lo, hi } = extent(mesh.positions);

    // Along the axis (renderer x): the segment's own extent, unpadded.
    near(lo[0], 1, 'min x follows the start point');
    near(hi[0], 5, 'max x follows the end point');

    // Across it: Width/2 either side of ifc y = 2, negated. Extruding along
    // the axis instead of across collapses this to a zero span.
    near(lo[2], -2.15, 'min z (thickness across the axis, negated)');
    near(hi[2], -1.85, 'max z');

    // Both endpoint Zs: start 0, end 2, plus Height 1 on top of the higher
    // end. Pinning the base to `startIfc[2]` — which the source comment says
    // it deliberately does not do — caps this at 1.
    near(lo[1], 0, 'min y follows the LOWER endpoint');
    near(hi[1], 3, 'max y follows the HIGHER endpoint plus Height');
  });

  it('gives a door its frame thickness across, not as its height', () => {
    // door and window call `buildAxisBox(..., Width, FrameThickness, Height)`
    // where column passes `(Width, Depth, Height)`. That per-type argument
    // order is a SECOND transcription, separate from the frame mapping, and
    // swapping the last two gives every door a 0.05 m tall, 2 m deep preview.
    const mesh = buildElementMesh({
      type: 'door',
      globalId: 8,
      storeyElevation: 0,
      payload: {
        type: 'door',
        params: { Width: 0.9, Height: 2.1, FrameThickness: 0.05 },
        position: [0, 0, 0],
      },
    });
    assert.ok(mesh);
    const { lo, hi } = extent(mesh.positions);
    near(hi[0] - lo[0], 0.9, 'width spans X');
    near(hi[1] - lo[1], 2.1, 'HEIGHT spans renderer Y, not the frame thickness');
    near(hi[2] - lo[2], 0.05, 'frame thickness spans renderer Z');
  });

  it('refuses a degenerate wall instead of emitting a zero-size preview', () => {
    // Control on the tests above, which assert a mesh IS built and would also
    // hold if this function built one for anything at all.
    //
    // The mirror hazard is covered by the beam test above rather than here: a
    // guard that rejects VALID input leaves this assertion green too, and in
    // this repo that is the more common of the two.
    const degenerate = buildElementMesh({
      type: 'wall',
      globalId: 9,
      storeyElevation: 0,
      payload: {
        type: 'wall',
        params: { Thickness: 0.2, Height: 3 },
        start: [1, 1, 0],
        end: [1, 1, 0], // zero length
      },
    });
    assert.equal(degenerate, null, 'a zero-length wall must not produce a preview');
  });
});
