/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';
import { readRhino3dm, RhinoReadError } from '../index.js';
import { craft, drawnTriangles, entityBounds, patchUuid, translation, type Craft } from '../../test-support/craft.js';
import { MAX_BLOCK_PLACEMENTS } from './blocks.js';
import { MAX_TEXT_DOTS } from './emit.js';

const unit = (c: Craft) => c.box([0, 0, 0], [1, 1, 1]);
const close = (a: number[], b: number[], digits = 9) => a.forEach((v, k) => expect(v).toBeCloseTo(b[k], digits));
const PLACEHOLDER = '11111111-2222-3333-4444-555555555555';

/** A chair block, a table block holding two chairs and a top, and two tables placed far out. */
function furniture(c: Craft) {
  const chair = c.block('Chair', [unit(c)]);
  const table = c.block('Table', [c.reference(chair, translation(2, 0, 0)), c.reference(chair, translation(-2, 0, 0)), c.box([0, 0, 1], [1, 1, 1.5])]);
  c.addInstance(table, translation(2_600_000.5, 1_200_000.25, 400), { name: 'table A', color: [200, 0, 0, 255] });
  // Rotated a quarter turn about Z and doubled in size.
  c.addInstance(table, [0, -2, 0, 100, 2, 0, 0, 200, 0, 0, 2, 300, 0, 0, 0, 1], { name: 'table B', color: [0, 0, 200, 255] });
}

describe('instances', () => {
  test('blocks come back as definitions plus flattened instance transforms (D4)', async () => {
    const result = await readRhino3dm(await craft(furniture));
    expect(result.entities.map(e => [e.name, e.geometryType])).toEqual([['table A', 'InstanceReference'], ['table B', 'InstanceReference']]);
    expect(result.meshes).toEqual([]);
    // First-use order: the table's own top, then the chair it nests.
    expect(result.definitions.map(d => [d.name, d.meshes.length, d.meshes[0].color])).toEqual([['Table', 1, null], ['Chair', 1, null]]);
    expect(result.instances.map(i => [i.entity, i.definition])).toEqual([[0, 0], [0, 1], [0, 1], [1, 0], [1, 1], [1, 1]]);
    // Nested transforms are composed in doubles: the survey-scale offset survives.
    expect(result.instances[1].transform).toEqual(translation(2_600_002.5, 1_200_000.25, 400));
    expect(result.instances[2].transform).toEqual(translation(2_599_998.5, 1_200_000.25, 400));
    expect(result.instances[4].transform).toEqual([0, -2, 0, 100, 2, 0, 0, 204, 0, 0, 2, 300, 0, 0, 0, 1]);
    expect(result.instances.map(i => i.color.map(v => Math.round(v * 255)))).toEqual([
      [200, 0, 0, 255], [200, 0, 0, 255], [200, 0, 0, 255], [0, 0, 200, 255], [0, 0, 200, 255], [0, 0, 200, 255],
    ]);
    expect(drawnTriangles(result)).toBe(72);
  });

  test('baking gives the same world geometry as instancing', async () => {
    const bytes = await craft(furniture);
    const instanced = await readRhino3dm(bytes), baked = await readRhino3dm(bytes, { bakeInstances: true });
    expect(baked.definitions).toEqual([]);
    expect(baked.instances).toEqual([]);
    expect(baked.meshes.map(m => m.entity)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(drawnTriangles(baked)).toBe(drawnTriangles(instanced));
    expect(baked.entities).toEqual(instanced.entities);
    for (const entity of [0, 1]) {
      const a = entityBounds(instanced, entity), b = entityBounds(baked, entity);
      close(a.min, b.min, 6); close(a.max, b.max, 6);
    }
    close(entityBounds(baked, 0).min, [2_599_998.5, 1_200_000.25, 400], 6);
    close(entityBounds(baked, 0).max, [2_600_003.5, 1_200_001.25, 401.5], 6);
    // Table B: x in 100 - 2·[0,1], y in 200 + 2·[-2,3], z in 300 + 2·[0,1.5].
    close(entityBounds(baked, 1).min, [98, 196, 300], 6);
    close(entityBounds(baked, 1).max, [100, 206, 303], 6);
    expect(baked.meshes.map(m => m.color.map(v => Math.round(v * 255)))[0]).toEqual([200, 0, 0, 255]);
    // Baked copies own their buffers, so every one can go on a transfer list.
    const buffers = baked.meshes.flatMap(m => [m.positions.buffer, m.normals.buffer, m.indices.buffer]);
    expect(new Set(buffers).size).toBe(buffers.length);
  });

  test('a baked normal is rotated, and a mirrored placement flips the winding', async () => {
    const bytes = await craft(c => {
      const plate = c.block('Plate', [c.mesh([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 1, 2]])]);
      c.addInstance(plate, [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1], { name: 'tilted' });
      c.addInstance(plate, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], { name: 'mirrored' });
    });
    const { meshes: [tilted, mirrored] } = await readRhino3dm(bytes, { bakeInstances: true });
    // +Z rotated a quarter turn about X points along -Y.
    close(Array.from(tilted.normals.subarray(0, 3)), [0, -1, 0]);
    expect(Array.from(tilted.indices)).toEqual([0, 1, 2]);
    // Mirroring in X keeps the plate's normal +Z, so the triangle must wind the other way to face it.
    close(Array.from(mirrored.normals.subarray(0, 3)), [0, 0, 1]);
    expect(Array.from(mirrored.indices)).toEqual([0, 2, 1]);
    expect(Array.from(mirrored.positions)).toEqual([0, 0, 0, -1, 0, 0, 0, 1, 0]);
  });

  test('block members keep their own colour unless they are "by parent"; curves and dots in a block are baked', async () => {
    const build = (c: Craft) => {
      const green = c.layer('Green', { color: [0, 255, 0, 255] });
      const inner = c.block('Inner', [unit(c)]);
      const mixed = c.block('Mixed',
        [unit(c), unit(c), unit(c), new c.rhino.PolylineCurve([[0, 0, 0], [1, 0, 0]]), c.textDot('tag', [0, 0, 2]), c.reference(inner), c.reference(inner)],
        [{ colorSource: 'ColorFromParent' }, { color: [9, 8, 7, 255] }, { colorSource: 'ColorFromLayer', layer: green },
          { colorSource: 'ColorFromParent' }, { color: [1, 1, 1, 255] }, { colorSource: 'ColorFromParent' }, { color: [50, 60, 70, 255] }]);
      c.addInstance(mixed, translation(10, 0, 0), { color: [200, 0, 0, 255] });
    };
    const bytes = await craft(build), rgb = (color: number[] | null) => color && color.map(v => Math.round(v * 255));
    const instanced = await readRhino3dm(bytes), baked = await readRhino3dm(bytes, { bakeInstances: true });
    expect(instanced.definitions[0].meshes.map(m => rgb(m.color))).toEqual([null, [9, 8, 7, 255], [0, 255, 0, 255]]);
    // The nested reference "by parent" passes the instance colour on; the other brings its own.
    expect(instanced.instances.map(i => rgb(i.color))).toEqual([[200, 0, 0, 255], [200, 0, 0, 255], [50, 60, 70, 255]]);
    expect(baked.meshes.map(m => rgb(m.color))).toEqual([[200, 0, 0, 255], [9, 8, 7, 255], [0, 255, 0, 255], [200, 0, 0, 255], [50, 60, 70, 255]]);
    // Every record owns its colour: editing one must not change another.
    expect(baked.meshes[0].color).not.toBe(baked.meshes[3].color);
    expect(instanced.instances[0].color).not.toBe(instanced.instances[1].color);
    for (const result of [instanced, baked]) {
      expect(result.curves).toEqual([{ entity: 0, origin: [10, 0, 0], positions: new Float32Array([0, 0, 0, 1, 0, 0]), closed: false, color: [200 / 255, 0, 0, 1] }]);
      expect(result.textDots).toEqual([{ entity: 0, position: [10, 0, 2], text: 'tag', color: [1 / 255, 1 / 255, 1 / 255, 1] }]);
    }
  });
});

test('a member whose colour is by a material that is by parent takes the instance colour, mesh and curve alike', async () => {
  const build = (c: Craft) => {
    const glass = c.material('Glass', [0, 0, 255, 255], 0.5), green = c.layer('Green', { color: [0, 255, 0, 255] });
    const spec = { layer: green, colorSource: 'ColorFromMaterial', materialSource: 'MaterialFromParent' } as const;
    const block = c.block('Pane', [unit(c), new c.rhino.PolylineCurve([[0, 0, 0], [1, 0, 0]])], [spec, spec]);
    c.addInstance(block, undefined, { layer: green, colorSource: 'ColorFromMaterial', material: glass, materialSource: 'MaterialFromObject' });
  };
  const bytes = await craft(build), blue = [0, 0, 1, 0.5];
  const instanced = await readRhino3dm(bytes), baked = await readRhino3dm(bytes, { bakeInstances: true });
  expect(instanced.definitions[0].meshes[0].color).toBeNull();
  expect([instanced.instances[0].color, instanced.curves[0].color, baked.meshes[0].color, baked.curves[0].color]).toEqual([blue, blue, blue, blue]);
});

test('a "by parent" member with a transparent material of its own takes the instance colour and its own transparency', async () => {
  const build = (c: Craft) => {
    const glass = c.material('Glass', [0, 0, 255, 255], 0.75);
    const spec = { colorSource: 'ColorFromParent', material: glass, materialSource: 'MaterialFromObject' } as const;
    const block = c.block('Pane', [unit(c), new c.rhino.PolylineCurve([[0, 0, 0], [1, 0, 0]]), unit(c)], [spec, spec, { colorSource: 'ColorFromParent' }]);
    c.addInstance(block, translation(3, 0, 0), { color: [200, 0, 0, 255] });
  };
  const bytes = await craft(build), red = [200 / 255, 0, 0, 1], faded = [200 / 255, 0, 0, 0.25];
  const instanced = await readRhino3dm(bytes), baked = await readRhino3dm(bytes, { bakeInstances: true });
  // One definition colour cannot say "the instance's colour at my own alpha", so that member is baked per placement.
  expect(instanced.definitions[0].meshes.map(m => m.color)).toEqual([null]);
  expect(instanced.instances.map(i => i.color)).toEqual([red]);
  expect(instanced.meshes.map(m => [m.color, m.origin])).toEqual([[faded, [3, 0, 0]]]);
  expect(baked.meshes.map(m => m.color).sort()).toEqual([faded, red].sort());
  expect([instanced.curves[0].color, baked.curves[0].color]).toEqual([faded, faded]);
  expect(drawnTriangles(instanced)).toBe(drawnTriangles(baked));
});

describe('guards', () => {
  /** A block whose second member references the block itself, placed once. */
  async function selfReferencing(): Promise<Uint8Array> {
    let block = '';
    const bytes = await craft(c => {
      block = c.block('Ouroboros', [unit(c), c.reference(PLACEHOLDER, translation(5, 0, 0))]);
      c.addInstance(block, translation(100, 0, 0), { name: 'loop' });
      c.addMesh(unit(c), { name: 'bystander' });
    });
    return patchUuid(bytes, PLACEHOLDER, block);
  }

  test('a block that contains itself terminates, draws once and reports the cycle', async () => {
    for (const bakeInstances of [false, true]) {
      const result = await readRhino3dm(await selfReferencing(), { bakeInstances });
      expect(result.entities.map(e => e.name)).toEqual(['loop', 'bystander']);
      expect(drawnTriangles(result)).toBe(24);
      close(entityBounds(result, 0).min, [100, 0, 0]);
      close(entityBounds(result, 0).max, [101, 1, 1]);
      expect(result.skipped).toEqual({ 'InstanceReference:cycle': 1 });
      expect(result.warnings).toEqual(['1 block reference point back into their own definition and are skipped.']);
    }
  });

  test('the same block down two branches is two copies, not a cycle', async () => {
    const result = await readRhino3dm(await craft(c => {
      const leaf = c.block('Leaf', [unit(c)]);
      const left = c.block('Left', [c.reference(leaf, translation(0, 0, 0))]), right = c.block('Right', [c.reference(leaf, translation(10, 0, 0))]);
      c.addInstance(c.block('Both', [c.reference(left), c.reference(right)]));
    }));
    expect(result.instances.map(i => i.transform[3])).toEqual([0, 10]);
    expect(result.skipped).toEqual({});
  });

  test('a reference to a block that is not in the file is counted, and the rest still draws', async () => {
    const result = await readRhino3dm(await craft(c => {
      c.addInstance(c.block('Half', [unit(c), c.reference(PLACEHOLDER)]));
    }));
    expect(drawnTriangles(result)).toBe(12);
    expect(result.skipped).toEqual({ 'InstanceReference:missing-definition': 1 });
  });

  const tenBoxes = (c: Craft) => {
    const box = c.block('Box', [unit(c)]);
    for (let i = 0; i < 6; i++) c.addInstance(box, translation(i * 2, 0, 0), { name: `instance ${i}` });
    for (let i = 0; i < 4; i++) c.addMesh(c.box([i * 2, 5, 0], [i * 2 + 1, 6, 1]), { name: `mesh ${i}` });
  };

  test.each([false, true])('the triangle budget bounds what is drawn (bakeInstances %s)', async bakeInstances => {
    const bytes = await craft(tenBoxes);
    // Below one box nothing fits, which is the refusal and no other failure.
    for (const maxTriangles of [0, 11]) {
      const error = await readRhino3dm(bytes, { bakeInstances, maxTriangles }).catch(e => e);
      expect(error).toBeInstanceOf(RhinoReadError);
      expect(error.code).toBe('no-renderable-geometry');
    }
    for (const maxTriangles of [12, 60, 71, 100, 119]) {
      const drawn = drawnTriangles(await readRhino3dm(bytes, { bakeInstances, maxTriangles }));
      expect(drawn).toBe(Math.floor(maxTriangles / 12) * 12);
    }
    expect(drawnTriangles(await readRhino3dm(bytes, { bakeInstances, maxTriangles: 120 }))).toBe(120);
  });

  test.each([false, true])('the triangle budget reports what it left out (bakeInstances %s)', async bakeInstances => {
    const bytes = await craft(tenBoxes);
    const full = await readRhino3dm(bytes, { bakeInstances, maxTriangles: 120 });
    expect([full.entities.length, full.skipped, full.warnings]).toEqual([10, {}, []]);
    // Room for five boxes: the sixth instance and all four meshes are left out, in file order.
    const cut = await readRhino3dm(bytes, { bakeInstances, maxTriangles: 60 });
    expect(cut.entities.map(e => e.name)).toEqual(['instance 0', 'instance 1', 'instance 2', 'instance 3', 'instance 4']);
    expect(cut.skipped).toEqual({ budget: 5 });
    expect(cut.warnings).toEqual(['Stopped at the budget of 60 triangles: 5 objects not drawn, or drawn in part.']);
  });

  test('point clouds and curves in a block are charged per placement, so blocks cannot multiply them without bound', async () => {
    // 300 points are charged as 100 triangles.
    const bytes = await craft(c => {
      const cloud = new c.rhino.PointCloud();
      for (let i = 0; i < 300; i++) cloud.add([i, 0, 0]);
      const scan = c.block('Scan', [cloud]);
      for (let i = 0; i < 10; i++) c.addInstance(scan, translation(0, i, 0), { name: `scan ${i}` });
    });
    const cut = await readRhino3dm(bytes, { maxTriangles: 450 });
    expect(cut.pointClouds).toHaveLength(4);
    expect(cut.entities.map(e => e.name)).toEqual(['scan 0', 'scan 1', 'scan 2', 'scan 3']);
    expect(cut.skipped).toEqual({ budget: 6 });
    expect(cut.warnings).toEqual(['Stopped at the budget of 450 triangles: 6 objects not drawn, or drawn in part.']);
    expect((await readRhino3dm(bytes, { maxTriangles: 1000 })).pointClouds).toHaveLength(10);
  });

  const SCALE = [1e15, 0, 0, 0, 0, 1e15, 0, 0, 0, 0, 1e15, 0, 0, 0, 0, 1];

  // Review finding on PR #9880.
  test.each([false, true])('a placement that flattens space, or pushes coordinates out of range, is counted and left out (bakeInstances %s)', async bakeInstances => {
    const bytes = await craft(c => {
      const box = c.block('Box', [unit(c)]), far = c.block('Far', [c.box([0, 0, 0], [1e30, 1e30, 1e30])]);
      c.addInstance(box, [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 1], { name: 'collapsed' });
      c.addInstance(far, SCALE, { name: 'overflowing' });
      // A last row other than 0 0 0 1 is a projection, which the reader does not apply.
      c.addInstance(box, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2], { name: 'projective' });
      c.addInstance(box, translation(1, 0, 0), { name: 'fine' });
    });
    const result = await readRhino3dm(bytes, { bakeInstances });
    expect(result.entities.map(e => e.name)).toEqual(['fine']);
    expect(result.skipped).toEqual({ 'InstanceReference:invalid': 2, 'transform:invalid': 1 });
    expect(result.meshes.every(m => m.positions.every(Number.isFinite) && m.normals.every(Number.isFinite) && m.origin.every(Number.isFinite))).toBe(true);
    expect(result.definitions.map(d => d.name)).toEqual(bakeInstances ? [] : ['Box']);
  });

  // Review finding on PR #9880.
  test.each([false, true])('a placement that pushes one of its meshes out of range draws the others, the same in both modes (bakeInstances %s)', async bakeInstances => {
    const result = await readRhino3dm(await craft(c => {
      const mixed = c.block('Mixed', [unit(c), c.box([0, 0, 0], [1e30, 1e30, 1e30])]);
      c.addInstance(mixed, SCALE, { name: 'stretched' });
      c.addInstance(mixed, translation(5, 0, 0), { name: 'moved' });
    }), { bakeInstances });
    expect(result.entities.map(e => e.name)).toEqual(['stretched', 'moved']);
    expect(result.skipped).toEqual({ 'transform:invalid': 1 });
    // The stretched placement keeps its unit box; the moved one keeps both meshes.
    expect(entityBounds(result, 0)).toEqual({ min: [0, 0, 0], max: Array(3).fill(Math.fround(1e15)) });
    expect(drawnTriangles(result)).toBe(36);
    expect(result.instances).toHaveLength(bakeInstances ? 0 : 1);
  });

  // Review finding on PR #9880.
  test.each([false, true])('geometry left out as out of range is not charged to the triangle budget (bakeInstances %s)', async bakeInstances => {
    const result = await readRhino3dm(await craft(c => {
      c.addInstance(c.block('Far', [c.box([0, 0, 0], [1e24, 1e24, 1e24])]), SCALE, { name: 'overflowing' });
      c.addMesh(unit(c), { name: 'fine' });
    }), { bakeInstances, maxTriangles: 12 });
    expect(result.entities.map(e => e.name)).toEqual(['fine']);
    expect(result.skipped).toEqual({ 'transform:invalid': 1 });
  });

  // Review finding on PR #9880.
  test.each([false, true])('parts left out as out of range are charged to the placement budget, so they cannot stall the walk (bakeInstances %s)', async bakeInstances => {
    // 2^12 placements of 200 meshes that the instance's scale pushes out of range: 819,200 parts that cost no triangles.
    const bytes = await craft(c => {
      let block = c.block('Far', Array.from({ length: 200 }, () => c.mesh([[0, 0, 0], [1e30, 0, 0], [0, 1e30, 0]], [[0, 1, 2]])));
      for (let level = 1; level <= 12; level++) block = c.block(`Level ${level}`, [c.reference(block), c.reference(block)]);
      c.addInstance(block, SCALE, { name: 'far' });
      c.addMesh(unit(c), { name: 'bystander' });
    });
    const result = await readRhino3dm(bytes, { bakeInstances });
    expect(result.entities.map(e => e.name)).toEqual(['bystander']);
    expect(result.skipped['transform:invalid']).toBeGreaterThan(MAX_BLOCK_PLACEMENTS * 0.9);
    expect(result.skipped['transform:invalid']).toBeLessThanOrEqual(MAX_BLOCK_PLACEMENTS + 200);
    expect(result.skipped.budget).toBe(1);
    expect(result.warnings).toEqual(['Stopped expanding blocks after 500,000 block references.']);
  });

  // Review finding on PR #9880.
  test.each([false, true])('text dots in a block are still drawn after another member spent the triangle budget (bakeInstances %s)', async bakeInstances => {
    const result = await readRhino3dm(await craft(c => {
      const leaf = c.block('Leaf', [unit(c), c.textDot('leaf', [0, 0, 2])]);
      const labelled = c.block('Labelled', [unit(c), new c.rhino.PolylineCurve([[0, 0, 0], [1, 0, 0]]), c.textDot('label', [0, 0, 1]), c.reference(leaf, translation(3, 0, 0))]);
      c.addInstance(labelled, undefined, { name: 'first' });
      c.addInstance(labelled, translation(0, 5, 0), { name: 'second' });
    }), { bakeInstances, maxTriangles: 12 });
    // One box fits. Every dot of both instances is there; the curve, the nested box and the second instance's geometry are not.
    expect(drawnTriangles(result)).toBe(12);
    expect(result.curves).toEqual([]);
    expect(result.textDots.map(d => [result.entities[d.entity].name, d.text, d.position])).toEqual([
      ['first', 'label', [0, 0, 1]], ['first', 'leaf', [3, 0, 2]], ['second', 'label', [0, 5, 1]], ['second', 'leaf', [3, 5, 2]],
    ]);
    expect(result.skipped).toEqual({ budget: 2 });
    expect(result.warnings).toEqual(['Stopped at the budget of 12 triangles: 2 objects not drawn, or drawn in part.']);
  });

  test('a block member that is hidden or on a layer that is off is not drawn in any instance', async () => {
    const result = await readRhino3dm(await craft(c => {
      const off = c.layer('Off', { visible: false }), on = c.layer('On');
      const block = c.block('Mixed', [unit(c), c.box([5, 0, 0], [6, 1, 1])], [{ layer: on, colorSource: 'ColorFromParent' }, { layer: off, colorSource: 'ColorFromParent' }]);
      c.addInstance(block, undefined, { layer: on });
    }));
    expect(result.definitions[0].meshes).toHaveLength(1);
    expect(entityBounds(result, 0).max).toEqual([1, 1, 1]);
    expect(result.entities[0].hidden).toBe(false);
    expect(result.skipped).toEqual({ 'hidden-block-member': 1 });
  });

  test('references that draw nothing are charged to the placement budget too', async () => {
    // 2^13 leaves of 200 references to a block that is not in the file: 1.6 million skips unless they are charged.
    const bytes = await craft(c => {
      let block = c.block('Leaf', [new c.rhino.PolylineCurve([[0, 0, 0], [1, 0, 0]]), ...Array.from({ length: 200 }, () => c.reference(PLACEHOLDER))]);
      for (let level = 1; level <= 13; level++) block = c.block(`Level ${level}`, [c.reference(block), c.reference(block, translation(level, 0, 0))]);
      c.addInstance(block, undefined, { name: 'fan' });
    });
    const result = await readRhino3dm(bytes);
    const walked = result.skipped['InstanceReference:missing-definition'] + result.curves.length;
    expect(walked).toBeLessThanOrEqual(MAX_BLOCK_PLACEMENTS);
    expect(walked).toBeGreaterThan(MAX_BLOCK_PLACEMENTS * 0.9);
    expect(result.skipped.budget).toBe(1);
    expect(result.warnings).toEqual(['Stopped expanding blocks after 500,000 block references.']);
  });

  test('text dots stop at their own limit, and the dots left out are counted and reported', async () => {
    // 30 instances of 40 placements of 100 dots: 120,000 dots, which no triangle budget sees.
    const bytes = await craft(c => {
      const dots = c.block('Dots', Array.from({ length: 100 }, (_, i) => c.textDot(`dot ${i}`, [i, 0, 0])));
      const rows = c.block('Rows', Array.from({ length: 40 }, (_, i) => c.reference(dots, translation(0, i, 0))));
      for (let i = 0; i < 30; i++) c.addInstance(rows, translation(0, 0, i), { name: `sheet ${i}` });
    });
    const result = await readRhino3dm(bytes);
    expect(result.textDots).toHaveLength(MAX_TEXT_DOTS);
    expect(result.entities).toHaveLength(MAX_TEXT_DOTS / 4000);
    expect(result.skipped).toEqual({ 'TextDot:limit': 120_000 - MAX_TEXT_DOTS });
    expect(result.warnings).toEqual(['Stopped after 100,000 text dots: 20,000 text dots left out.']);
  });

  test('past the text dot limit a placement costs the walk one step, however many dots it holds', async () => {
    // 2^17 placements of 2,000 dots are 262 million dots: minutes if each were visited, and the placement budget is not reached.
    const bytes = await craft(c => {
      let block = c.block('Dots', Array.from({ length: 2000 }, (_, i) => c.textDot('d', [i, 0, 0])));
      for (let level = 1; level <= 17; level++) block = c.block(`Level ${level}`, [c.reference(block), c.reference(block, translation(0, level, 0))]);
      c.addInstance(block);
    });
    const started = performance.now();
    const result = await readRhino3dm(bytes);
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(result.textDots).toHaveLength(MAX_TEXT_DOTS);
    expect(result.skipped).toEqual({ 'TextDot:limit': 2000 * 2 ** 17 - MAX_TEXT_DOTS });
  });

  // Review finding on PR #9880.
  test('past the triangle budget a branch that leads to no text dot ends at once and leaves the placement budget alone', async () => {
    // 2^20 placements, which would spend the placement budget if the walk went on looking for dots.
    const result = await readRhino3dm(await craft(c => {
      c.addMesh(unit(c), { name: 'box' });
      let block = c.block('Level 0', [unit(c)]);
      for (let level = 1; level <= 20; level++) block = c.block(`Level ${level}`, [c.reference(block), c.reference(block, translation(level, 0, 0))]);
      c.addInstance(block, undefined, { name: 'fan' });
      // A block that draws nothing loses nothing to the budget.
      c.addInstance(c.block('Empty', [c.reference(PLACEHOLDER)]), undefined, { name: 'empty' });
      c.addInstance(c.block('Label', [c.textDot('label', [0, 0, 0])]), undefined, { name: 'label' });
    }), { maxTriangles: 12 });
    expect(result.entities.map(e => e.name)).toEqual(['box', 'label']);
    expect(result.skipped).toEqual({ budget: 1 });
    expect(result.warnings).toEqual(['Stopped at the budget of 12 triangles: 1 object not drawn, or drawn in part.']);
  });

  // Review finding on PR #9880.
  test('the text dot limit counts dots left out as invalid, so they cannot stall the walk either', async () => {
    // 2^12 placements of 2,000 dots that the instance's scale pushes out of the f64 range: 8 million visits unless they count.
    const bytes = await craft(c => {
      let block = c.block('Dots', Array.from({ length: 2000 }, (_, i) => c.textDot('d', [1e300, i, 0])));
      for (let level = 1; level <= 12; level++) block = c.block(`Level ${level}`, [c.reference(block), c.reference(block)]);
      c.addInstance(block, SCALE, { name: 'far dots' });
      c.addMesh(unit(c), { name: 'bystander' });
    });
    const result = await readRhino3dm(bytes);
    expect(result.textDots).toEqual([]);
    expect(result.entities.map(e => e.name)).toEqual(['bystander']);
    expect(result.skipped).toEqual({ 'TextDot:invalid': MAX_TEXT_DOTS, 'TextDot:limit': 2000 * 2 ** 12 - MAX_TEXT_DOTS });
    expect(result.warnings).toEqual(['Stopped after 100,000 text dots: 8,092,000 text dots left out.']);
  });

  test('a reference that could never be drawn keeps its own reason after the placement budget is spent', async () => {
    const bytes = await craft(c => {
      let block = c.block('Level 0', [new c.rhino.PolylineCurve([[0, 0, 0], [1, 0, 0]])]);
      for (let level = 1; level <= 20; level++) block = c.block(`Level ${level}`, [c.reference(block), c.reference(block, translation(level, 0, 0))]);
      c.addInstance(block, undefined, { name: 'fan' });
      c.addInstance(PLACEHOLDER, undefined, { name: 'dangling' });
    });
    expect((await readRhino3dm(bytes)).skipped).toEqual({ budget: 1, 'InstanceReference:missing-definition': 1 });
  });

  test('a fan-out of empty blocks stops at the placement budget and reports it', async () => {
    // Twenty levels that each reference the next twice: 2^20 placements with no triangle to charge.
    const bytes = await craft(c => {
      let block = c.block('Level 0', [new c.rhino.PolylineCurve([[0, 0, 0], [1, 0, 0]])]);
      for (let level = 1; level <= 20; level++) block = c.block(`Level ${level}`, [c.reference(block), c.reference(block, translation(level, 0, 0))]);
      c.addInstance(block, undefined, { name: 'fan' });
      c.addMesh(unit(c), { name: 'bystander' });
    });
    const started = performance.now();
    const result = await readRhino3dm(bytes);
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(result.entities.map(e => e.name)).toEqual(['fan', 'bystander']);
    expect(result.curves.length).toBeLessThan(MAX_BLOCK_PLACEMENTS);
    expect(result.curves.length).toBeGreaterThan(0);
    expect(result.skipped).toEqual({ budget: 1 });
    expect(result.warnings).toEqual(['Stopped expanding blocks after 500,000 block references.']);
  });
});

describe('frame', () => {
  const W = '1 0 0 2600000 0 1 0 1200000 0 0 1 400 0 0 0 1';
  const scene = (coordinates: string | null, world: string | null) => (c: Craft) => {
    if (coordinates) c.string('IFC::Coordinates', coordinates);
    if (world) c.string('IFC::WorldFromModel', world);
    c.addMesh(c.box([1, 2, 3], [2, 3, 4]), { name: 'mesh' });
    c.addInstance(c.block('Box', [unit(c)]), translation(10, 0, 0), { name: 'instance' });
    c.addPolyline([[0, 0, 0], [1, 0, 0]], { name: 'curve' });
    c.addTextDot('dot', [5, 5, 5], { name: 'dot' });
  };

  test.each([false, true])('IFC::WorldFromModel moves every coordinate under local coordinates (bakeInstances %s)', async bakeInstances => {
    const result = await readRhino3dm(await craft(scene('local', W)), { bakeInstances });
    expect(result.document.frame).toBe('ifc-world-from-model');
    close(entityBounds(result, 0).min, [2_600_001, 1_200_002, 403], 6);
    close(entityBounds(result, 1).min, [2_600_010, 1_200_000, 400], 6);
    close(entityBounds(result, 1).max, [2_600_011, 1_200_001, 401], 6);
    expect(result.curves[0].origin).toEqual([2_600_000, 1_200_000, 400]);
    expect(result.textDots[0].position).toEqual([2_600_005, 1_200_005, 405]);
    // A pure translation leaves the f32 offsets untouched.
    expect(Math.max(...result.meshes[0].positions)).toBe(1);
  });

  test.each([
    ['world coordinates, as exports before the fix wrote it', 'world', W],
    ['no IFC::Coordinates', null, W],
    ['no matrix', 'local', null],
  ])('the file frame is kept with %s', async (_name, coordinates, world) => {
    const result = await readRhino3dm(await craft(scene(coordinates, world)));
    expect(result.document.frame).toBe('file');
    expect(entityBounds(result, 0).min).toEqual([1, 2, 3]);
    expect(result.warnings).toEqual([]);
  });

  test('a malformed matrix is ignored with a warning', async () => {
    const result = await readRhino3dm(await craft(scene('local', '1 0 0 nope')));
    expect(result.document.frame).toBe('file');
    expect(entityBounds(result, 0).min).toEqual([1, 2, 3]);
    expect(result.warnings).toEqual(['IFC::WorldFromModel is not a usable 4×4 matrix; the file is shown in its own coordinates.']);
  });

  test('a matrix that flattens space is ignored the same way', async () => {
    const result = await readRhino3dm(await craft(scene('local', '1 0 0 5 0 1 0 5 0 0 0 5 0 0 0 1')));
    expect(result.document.frame).toBe('file');
    expect(entityBounds(result, 0).min).toEqual([1, 2, 3]);
  });

  test.each([
    ['a scaling last entry', '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 2'],
    ['a perspective row', '1 0 0 0 0 1 0 0 0 0 1 0 0 0 1e-6 1'],
  ])('a matrix that is not affine (%s) is ignored with a warning, not applied as if it were', async (_name, world) => {
    const result = await readRhino3dm(await craft(scene('local', world)));
    expect(result.document.frame).toBe('file');
    expect(entityBounds(result, 0).min).toEqual([1, 2, 3]);
    expect(result.warnings).toEqual(['IFC::WorldFromModel is not a usable 4×4 matrix; the file is shown in its own coordinates.']);
  });

  test('rounding noise in the last row does not make a matrix a projection', async () => {
    const result = await readRhino3dm(await craft(scene('local', '1 0 0 2600000 0 1 0 1200000 0 0 1 400 0 1e-17 0 0.9999999999999999')));
    expect(result.document.frame).toBe('ifc-world-from-model');
    expect(result.warnings).toEqual([]);
  });

  test('a rotating matrix turns positions and normals and keeps the origin in doubles', async () => {
    // A quarter turn about Z, then the survey offset.
    const result = await readRhino3dm(await craft(scene('local', '0 -1 0 2600000 1 0 0 1200000 0 0 1 400 0 0 0 1')));
    close(entityBounds(result, 0).min, [2_600_000 - 3, 1_200_000 + 1, 403], 6);
    close(entityBounds(result, 0).max, [2_600_000 - 2, 1_200_000 + 2, 404], 6);
    // Every normal turns with the matrix: (x, y, z) becomes (-y, x, z).
    const before = (await readRhino3dm(await craft(scene(null, null)))).meshes[0].normals, after = result.meshes[0].normals;
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i += 3) close([after[i], after[i + 1], after[i + 2]], [-before[i + 1], before[i], before[i + 2]], 6);
    expect(before[0]).not.toBe(0);
  });
});
