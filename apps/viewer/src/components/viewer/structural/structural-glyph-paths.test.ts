/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The drawing half of the structural glyph overlay (#9668): the move into a
 * model's render frame, and symbol sizes against a stub camera that projects
 * `pxPerMetre` pixels per metre (x right, render Y up the screen).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StructuralGlyph } from '@ifc-lite/parser/structural-glyphs';
import { glyphPath, MIN_PX, toViewGlyphs, type Project } from './structural-glyph-paths';

const source = { expressId: 7, globalId: 'g', type: 'IfcStructuralPointConnection' };
const ortho = (pxPerMetre: number): Project => (p) => ({ x: 500 + p.x * pxPerMetre, y: 500 - p.y * pxPerMetre });

/** Every coordinate pair in a path, as numbers. */
function points(d: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const m of d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) out.push({ x: Number(m[1]), y: Number(m[2]) });
  return out;
}
const extent = (d: string) => {
  const ps = points(d);
  return Math.max(...ps.map((p) => p.y)) - Math.min(...ps.map((p) => p.y));
};

describe('toViewGlyphs', () => {
  it('turns IFC Z-up metres into the model render frame, the same rule as the IfcGrid overlay', () => {
    const glyph: StructuralGlyph = { kind: 'force', distribution: 'point', position: [1, 2, 3], direction: [0, 0, -1], magnitude: 1, relative: 1, source };
    const [view] = toViewGlyphs([glyph], {
      originShift: { x: 10, y: 20, z: 30 },
      wasmRtcOffset: { x: 0, y: 0, z: 0 },
    } as Parameters<typeof toViewGlyphs>[1]);
    // IFC (x, y, z) is render (x, z, -y), minus the Y-up origin shift.
    assert.deepEqual(view.position, { x: 1 - 10, y: 3 - 20, z: -2 - 30 });
    assert.deepEqual(view.direction, { x: 0, y: -1, z: 0 });
  });
});

describe('glyphPath sizing', () => {
  const support = toViewGlyphs([{ kind: 'support', support: 'pinned', position: [0, 0, 0], direction: [0, 0, 1], source }], undefined);

  it('keeps a support the same on-screen size when zoomed in', () => {
    const near = extent(glyphPath(support, ortho(10_000), 1));
    const nearer = extent(glyphPath(support, ortho(100_000), 1));
    assert.ok(near > 15 && near < 30, `support spans ${near}px`);
    assert.equal(nearer, near);
  });

  it('shrinks a support to its world cap when zoomed out, but not below the floor', () => {
    // 1 m cap at 8 px/m: the symbol may not be larger than 8 px.
    const capped = extent(glyphPath(support, ortho(8), 1));
    assert.ok(capped <= 8 * 1.6 && capped < extent(glyphPath(support, ortho(10_000), 1)), `capped support spans ${capped}px`);
    const floor = extent(glyphPath(support, ortho(0.01), 1));
    assert.ok(floor >= MIN_PX, `far support spans ${floor}px`);
  });

  it('draws a force pointing into its node, longer for the larger load of its group', () => {
    const force = (relative: number) => toViewGlyphs([{ kind: 'force', distribution: 'point', position: [0, 0, 0], direction: [0, 0, -1], magnitude: relative, relative, source }], undefined);
    const big = points(glyphPath(force(1), ortho(10_000), 1));
    const small = points(glyphPath(force(0.2), ortho(10_000), 1));
    // The shaft runs from the tail (above, smaller y) down to the node at (500, 500).
    assert.deepEqual(big[1], { x: 500, y: 500 });
    assert.ok(big[0].y < 500);
    assert.ok(500 - big[0].y > 500 - small[0].y);
  });

  it('draws nothing for a glyph behind the camera', () => {
    assert.equal(glyphPath(support, () => null, 1), '');
  });
});
