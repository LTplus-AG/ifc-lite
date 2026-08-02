/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createCollabDoc } from '../src/doc/schema.js';
import { createEntity } from '../src/doc/entity.js';
import { snapshotToIfcx } from '../src/snapshot/to-ifcx.js';
import {
  USD_XFORMOP,
  matrixToPlacement,
  placementToMatrix,
  setEntityPlacement,
  getEntityPlacement,
  type LocalPlacement,
} from '../src/doc/placement.js';

/**
 * Apply a row-vector matrix to a point the EXACT way `@ifc-lite/ifcx`
 * `applyTransform` does (the parser that consumes `usd::xformop`):
 *   out_j = Σ_i p_i · M[i][j] + M[3][j]
 * Keeping this identical to the consumer is the whole point of the test —
 * if the convention drifts, placed geometry lands in the wrong spot.
 */
function applyRowVec(m: number[][], p: [number, number, number]): [number, number, number] {
  const [x, y, z] = p;
  return [
    m[0][0] * x + m[1][0] * y + m[2][0] * z + m[3][0],
    m[0][1] * x + m[1][1] * y + m[2][1] * z + m[3][1],
    m[0][2] * x + m[1][2] * y + m[2][2] * z + m[3][2],
  ];
}

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);
const nearVec = (a: number[], b: number[]) => a.forEach((v, i) => near(v, b[i]));

describe('placement math', () => {
  it('translation-only placement round-trips through matrix', () => {
    const p: LocalPlacement = { location: [3, 4, 5] };
    const back = matrixToPlacement(placementToMatrix(p));
    nearVec(back.location, [3, 4, 5]);
    nearVec(back.axis!, [0, 0, 1]);
    nearVec(back.refDirection!, [1, 0, 0]);
  });

  it('places the local origin at `location` and offsets along the local axes', () => {
    const m = placementToMatrix({ location: [10, 20, 30] });
    nearVec(applyRowVec(m, [0, 0, 0]), [10, 20, 30]); // origin → location
    nearVec(applyRowVec(m, [1, 0, 0]), [11, 20, 30]); // +X local
    nearVec(applyRowVec(m, [0, 0, 1]), [10, 20, 31]); // +Z local
  });

  it('90° yaw about Z rotates local +X onto world +Y', () => {
    // refDirection = world +Y means the local +X axis points along world +Y.
    const m = placementToMatrix({ location: [0, 0, 0], axis: [0, 0, 1], refDirection: [0, 1, 0] });
    const worldX = applyRowVec(m, [1, 0, 0]);
    nearVec(worldX, [0, 1, 0]);
    // Decompose preserves the yaw direction.
    const back = matrixToPlacement(m);
    nearVec(back.refDirection!, [0, 1, 0]);
  });

  it('refDirection is orthonormalized against the axis (Gram–Schmidt)', () => {
    // refDirection not perpendicular to Z → projected back into the XY plane.
    const m = placementToMatrix({ location: [0, 0, 0], axis: [0, 0, 1], refDirection: [1, 0, 5] });
    const back = matrixToPlacement(m);
    near(back.refDirection![2], 0); // Z component removed
    near(Math.hypot(...back.refDirection!), 1); // unit length
  });
});

describe('placement on the Y.Doc', () => {
  it('set / get round-trips through usd::xformop', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wall-1', { ifcClass: 'IfcWall' });
    setEntityPlacement(doc, '/wall-1', { location: [1, 2, 3], axis: [0, 0, 1], refDirection: [0, 1, 0] });

    const got = getEntityPlacement(doc, '/wall-1');
    expect(got).not.toBeNull();
    nearVec(got!.location, [1, 2, 3]);
    nearVec(got!.refDirection!, [0, 1, 0]);
  });

  it('getEntityPlacement returns null when no placement is set', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wall-2', { ifcClass: 'IfcWall' });
    expect(getEntityPlacement(doc, '/wall-2')).toBeNull();
  });

  it('placement rides through snapshotToIfcx as a node attribute (no writer change)', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wall-3', { ifcClass: 'IfcWall' });
    setEntityPlacement(doc, '/wall-3', { location: [9, 8, 7] });

    const ifcx = snapshotToIfcx(doc);
    const node = ifcx.data.find((n) => n.path === '/wall-3');
    expect(node).toBeDefined();
    const xform = node!.attributes?.[USD_XFORMOP] as { transform: number[][] } | undefined;
    expect(xform).toBeDefined();
    // Row 3 carries the translation.
    nearVec(xform!.transform[3], [9, 8, 7, 1]);
  });
});
