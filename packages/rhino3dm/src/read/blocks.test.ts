/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';
import { readRhino3dm, type RhinoImport } from '../index.js';
import { craft, drawnTriangles, entityBounds, patchUuid, translation, type Craft } from '../../test-support/craft.js';
import { MAX_BLOCK_PLACEMENTS } from './blocks.js';

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
    for (const maxTriangles of [0, 11, 12, 60, 71, 100, 119]) {
      expect(drawnTriangles(await readRhino3dm(bytes, { bakeInstances, maxTriangles }).catch((): RhinoImport => empty))).toBeLessThanOrEqual(maxTriangles);
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

  test('a placement that flattens space, or pushes coordinates out of range, is counted and left out', async () => {
    const bytes = await craft(c => {
      const box = c.block('Box', [unit(c)]), far = c.block('Far', [c.box([0, 0, 0], [1e30, 1e30, 1e30])]);
      c.addInstance(box, [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 1], { name: 'collapsed' });
      c.addInstance(far, [1e15, 0, 0, 0, 0, 1e15, 0, 0, 0, 0, 1e15, 0, 0, 0, 0, 1], { name: 'overflowing' });
      c.addInstance(box, translation(1, 0, 0), { name: 'fine' });
    });
    const baked = await readRhino3dm(bytes, { bakeInstances: true });
    expect(baked.entities.map(e => e.name)).toEqual(['fine']);
    expect(baked.skipped).toEqual({ 'InstanceReference:invalid': 1, 'transform:invalid': 1 });
    expect(baked.meshes.every(m => m.positions.every(Number.isFinite) && m.normals.every(Number.isFinite) && m.origin.every(Number.isFinite))).toBe(true);
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
    expect(result.warnings).toEqual(['Stopped expanding blocks after 500,000 placements.']);
  });
});

const empty: RhinoImport = {
  format: 'ifc-lite.rhino-import', version: 1,
  document: { archiveVersion: 80, application: '', unitSystem: 'Meters', metersPerUnit: 1, provenance: 'rhino', frame: 'file', earthAnchor: null, strings: [] },
  layers: [], entities: [], meshes: [], definitions: [], instances: [], pointClouds: [], curves: [], textDots: [], skipped: {}, warnings: [],
};

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
