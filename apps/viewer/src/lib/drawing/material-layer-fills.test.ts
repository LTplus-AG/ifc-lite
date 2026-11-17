/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9296 (modelling parity, layered-walls row): the cut of a brick / insulation
 * / plaster wall came back as three polygons, one per material, all filled in
 * the wall's own grey, because none of the three materials has a colour.
 * The polygons below are that measured cut (real GPU run), outlines shortened.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DrawingPolygon } from '@ifc-lite/drawing-2d';
import { withMaterialLayerFills } from './material-layer-fills.js';

type Rgba = [number, number, number, number];
const GREY: Rgba = [0.85, 0.85, 0.85, 1];
const layer = (entityId: number, materialId: number | undefined, color: Rgba | undefined, x: number): DrawingPolygon => ({
  polygon: { outer: [{ x, y: 0 }, { x: x + 0.1, y: 0 }, { x: x + 0.1, y: 3 }, { x, y: 3 }], holes: [] },
  entityId, ifcType: 'IfcWall', modelIndex: 0, isCut: true,
  ...(color ? { color, sourceColor: color } : {}), ...(materialId === undefined ? {} : { materialId }),
});
const NAMES = new Map([[34, 'Brick'], [35, 'Insulation'], [36, 'Plaster'], [40, 'Core'], [41, 'Finish']]);
const nameOf = (p: Pick<DrawingPolygon, 'materialId'>) => NAMES.get(p.materialId ?? -1);
const distinct = (polygons: readonly DrawingPolygon[]) => new Set(polygons.map((p) => JSON.stringify(p.color))).size;

describe('layers of one cut element fill per material (#9296)', () => {
  const wall = [layer(60, 34, GREY, 0), layer(60, 35, GREY, 0.1), layer(60, 36, GREY, 0.2)];

  it('three materials drawn in the wall\'s one colour get three fills, by what their names say', () => {
    const filled = withMaterialLayerFills(wall, nameOf);
    assert.equal(distinct(filled), 3);
    const [brick, insulation, plaster] = filled.map((p) => p.color!);
    assert.ok(brick[0] > brick[2] + 0.2, 'brick reads red-brown');
    assert.ok(insulation[0] > 0.8 && insulation[1] > 0.7 && insulation[2] < 0.6, 'insulation reads yellow');
    assert.ok(Math.min(...plaster.slice(0, 3)) > 0.8, 'plaster reads near white');
    assert.deepEqual(filled.map((p) => p.sourceColor), [GREY, GREY, GREY], 'the 3D cap\'s source colour is untouched');
    assert.deepEqual(filled.map((p) => p.polygon), wall.map((p) => p.polygon), 'outlines are untouched');
  });

  it('names that say nothing still get distinct, stable fills', () => {
    const plain = [layer(70, 40, GREY, 0), layer(70, 41, GREY, 0.15)];
    const first = withMaterialLayerFills(plain, nameOf);
    assert.equal(distinct(first), 2);
    assert.deepEqual(withMaterialLayerFills(plain, nameOf), first, 'the same drawing fills the same way again');
    assert.equal(distinct(withMaterialLayerFills(plain, () => undefined)), 2, 'unnamed materials too');
  });

  it('two materials of one name kind never share a fill', () => {
    const bricks = [layer(80, 1, GREY, 0), layer(80, 2, GREY, 0.1)];
    assert.equal(distinct(withMaterialLayerFills(bricks, () => 'Brick')), 2);
  });

  it('a material with a colour of its own keeps it, and the others avoid it', () => {
    const red: Rgba = [0.8, 0.1, 0.1, 1];
    const mixed = [layer(90, 34, red, 0), layer(90, 35, GREY, 0.1), layer(90, 36, GREY, 0.2)];
    const filled = withMaterialLayerFills(mixed, nameOf);
    assert.deepEqual(filled[0].color, red);
    assert.equal(distinct(filled), 3);
  });

  it('leaves alone what is already told apart, or is not layered', () => {
    const coloured = [layer(1, 34, [1, 0, 0, 1], 0), layer(1, 35, [0, 1, 0, 1], 0.1)];
    assert.equal(withMaterialLayerFills(coloured, nameOf), coloured, 'distinct colours: the same array back');
    const single = [layer(2, 34, GREY, 0), layer(2, 34, GREY, 0.1), layer(3, undefined, undefined, 0)];
    assert.equal(withMaterialLayerFills(single, nameOf), single, 'one material, or none');
    const twoWalls = [layer(4, 34, GREY, 0), layer(5, 35, GREY, 1)];
    assert.equal(withMaterialLayerFills(twoWalls, nameOf), twoWalls, 'layers are compared within one element only');
  });
});
