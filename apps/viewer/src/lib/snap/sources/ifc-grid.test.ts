/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The design-grid snap source (#6232 D3): the storey's IfcGrid axes and their
 * crossings feed the modeling profile, so a click near a crossing lands ON it
 * with the grid glyph, and the source re-reads only when the model or storey
 * changes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { glyphFor } from '@/components/viewer/tools/command/snap-hud-geometry';
import { solveSnap } from '../solve.js';
import { MODELING_SNAP_PROFILE } from '../rank.js';
import type { SnapCandidate } from '../types.js';
import { createIfcGridSource, gridAxisIntersections, type GridAxisLine } from './ifc-grid.js';
import { createLineworkSource } from './linework.js';
import { query } from '@/test/snap-fixture.js';

/** Grid 7: 1, 2 at x = 0, 6 (y from -1 to 9), A, B at y = 0, 8 (x from -1 to 7), all in storey-local metres. */
const AXES: GridAxisLine[] = [
  { gridId: 7, axisId: 71, AxisTag: '1', family: 'U', a: [0, -1], b: [0, 9] },
  { gridId: 7, axisId: 72, AxisTag: '2', family: 'U', a: [6, -1], b: [6, 9] },
  { gridId: 7, axisId: 73, AxisTag: 'A', family: 'V', a: [-1, 0], b: [7, 0] },
  { gridId: 7, axisId: 74, AxisTag: 'B', family: 'V', a: [-1, 8], b: [7, 8] },
];

const source = (axes: readonly GridAxisLine[] = AXES, deps: { storey?: number | null; version?: () => number } = {}) => createIfcGridSource({
  modelId: 'm',
  version: deps.version ?? (() => 0),
  storeyId: () => (deps.storey === undefined ? 40 : deps.storey),
  loadAxes: () => axes,
});
const PROFILE = { ...MODELING_SNAP_PROFILE, sources: ['ifc-grid', 'linework'] };

describe('gridAxisIntersections (#6232 D3)', () => {
  it('finds the crossings of different families only, tagged', () => {
    const crossings = gridAxisIntersections(AXES);
    assert.deepEqual(
      crossings.map((c) => [c.tags.join(''), c.at[0], c.at[1]]),
      [['1A', 0, 0], ['1B', 0, 8], ['2A', 6, 0], ['2B', 6, 8]],
    );
  });

  it('ignores axes that do not reach each other, other grids and parallel lines', () => {
    const short: GridAxisLine = { gridId: 7, axisId: 75, AxisTag: 'C', family: 'V', a: [10, 3], b: [12, 3] };
    const other: GridAxisLine = { gridId: 9, axisId: 76, AxisTag: 'X', family: 'V', a: [-1, 3], b: [7, 3] };
    assert.equal(gridAxisIntersections([...AXES, short, other]).length, 4);
  });

  it('keeps the crossing of an axis that ends exactly on another', () => {
    const tee: GridAxisLine[] = [
      { gridId: 1, axisId: 77, AxisTag: '1', family: 'U', a: [0, 0], b: [0, 5] },
      { gridId: 1, axisId: 78, AxisTag: 'A', family: 'V', a: [0, 5], b: [4, 5] },
    ];
    assert.deepEqual(gridAxisIntersections(tee).map((c) => c.at), [[0, 5]]);
  });
});

describe('createIfcGridSource (#6232 D3)', () => {
  it('offers the crossing near the cursor and both axes through it, as an edge on an axis guide', () => {
    const out: SnapCandidate[] = [];
    source().collect(query([6.05, 0.05], { metresPerPixel: 0.01 }), 0.5, out);
    assert.deepEqual(out.filter((c) => c.kind === 'gridIntersection').map((c) => c.local), [[6, 0]]);
    const edges = out.filter((c) => c.kind === 'edge');
    assert.equal(edges.length, 2);
    for (const edge of edges) {
      assert.equal(edge.source, 'ifc-grid');
      assert.equal(edge.guide?.kind, 'segment');
      assert.equal(edge.guide?.role, 'axis');
    }
  });

  it('a click near a crossing lands on it and shows the grid glyph', () => {
    const solved = solveSnap(query([6.06, 0.05]), [source()], PROFILE);
    assert.equal(solved.winner?.kind, 'gridIntersection');
    assert.deepEqual(solved.local, [6, 0]);
    assert.equal(glyphFor(solved), 'grid');
  });

  it('beats a grid axis and a nearer edge in the same tier ladder, but not a wall endpoint', () => {
    const wall = createLineworkSource({ segments: [[[6.02, 0.02], [6.02, 4]]] });
    const onEndpoint = solveSnap(query([6.03, 0.03]), [source(), wall], PROFILE);
    assert.equal(onEndpoint.winner?.kind, 'endpoint', 'the wall end outranks the grid crossing');
    const onAxis = solveSnap(query([3, 0.04]), [source()], PROFILE);
    assert.equal(onAxis.winner?.kind, 'edge');
    assert.deepEqual(onAxis.local, [3, 0]);
    assert.ok(onAxis.guides.some((g) => g.role === 'axis'), 'the axis is drawn as a guide');
  });

  it('a typed length lock slides along the axis instead of snapping off it', () => {
    const solved = solveSnap(query([2.9, 0.03], { anchor: [0, 0], locks: { length: 3 } }), [source()], PROFILE);
    assert.deepEqual([solved.local[0], solved.local[1]], [3, 0]);
  });

  it('reads the axes once per version and storey, and offers nothing without a storey', () => {
    let version = 0;
    let loads = 0;
    const counting = createIfcGridSource({
      modelId: 'm', version: () => version, storeyId: () => 40, loadAxes: () => { loads++; return AXES; },
    });
    const out: SnapCandidate[] = [];
    for (let i = 0; i < 5; i++) counting.collect(query([6, 0]), 0.5, out);
    assert.equal(loads, 1);
    version = 1;
    counting.collect(query([6, 0]), 0.5, out);
    assert.equal(loads, 2);
    const none: SnapCandidate[] = [];
    source(AXES, { storey: null }).collect(query([6, 0]), 0.5, none);
    assert.equal(none.length, 0);
  });
});
