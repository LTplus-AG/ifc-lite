// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseObj, productMeasures, compareProduct, sourceIdentity } from './real-authoring-support.mjs';

const cube = (name, size, shift = 0) => {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
    .map(([x, y, z]) => `v ${(x * size + shift).toFixed(6)} ${(y * size).toFixed(6)} ${(z * size).toFixed(6)}`);
  return { name, v };
};
const faces = base => [[1, 3, 2], [1, 4, 3], [5, 6, 7], [5, 7, 8], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 4, 8], [3, 8, 7], [4, 1, 5], [4, 5, 8]]
  .map(f => `f ${f.map(i => i + base).join(' ')}`);
const obj = (...cubes) => `# header\n${cubes.map((c, i) => [`o ${c.name}`, `g ${c.name}`, ...c.v, ...faces(i * 8)].join('\n')).join('\n')}\n`;

test('real-authoring helpers measure volume, area and bounds of closed OBJ objects', () => {
  const objects = parseObj(obj(cube('IfcWall_1', 2), cube('IfcSlab_2', 1, 10)));
  assert.deepEqual([...objects.keys()], ['IfcWall_1', 'IfcSlab_2']);
  const wall = productMeasures(objects.get('IfcWall_1'));
  assert.ok(Math.abs(wall.volume - 8) < 1e-12 && Math.abs(wall.area - 24) < 1e-12);
  assert.deepEqual(wall.min, [0, 0, 0]);
  assert.deepEqual(productMeasures(objects.get('IfcSlab_2')).min, [10, 0, 0]);
});

test('repeated object blocks of one name concatenate and faces keep global indices', () => {
  const text = `${obj(cube('IfcWall_1', 1))}o IfcWall_1\n${cube('x', 1, 5).v.join('\n')}\n${faces(8).join('\n')}\n`;
  const wall = productMeasures(parseObj(text).get('IfcWall_1'));
  assert.ok(Math.abs(wall.volume - 2) < 1e-12);
  assert.equal(wall.triangles, 24);
});

test('compareProduct accepts the measured deviation and rejects a larger one; curved products are report only', () => {
  const tolerance = { volumeRelative: 1e-5, bboxMetres: 1e-4 };
  const exact = productMeasures(parseObj(obj(cube('a', 1))).get('a'));
  const near = { ...exact, volume: exact.volume * (1 + 5e-6) };
  assert.equal(compareProduct(near, exact, { curved: 'false', exact_vol_rel: '0', exact_bbox_dev_m: '0' }, tolerance).ok, true);
  const far = { ...exact, volume: exact.volume * (1 + 1e-3) };
  assert.equal(compareProduct(far, exact, { curved: 'false', exact_vol_rel: '0', exact_bbox_dev_m: '0' }, tolerance).ok, false);
  assert.equal(compareProduct(far, exact, { curved: 'false', exact_vol_rel: '0.002', exact_bbox_dev_m: '0' }, tolerance).ok, true,
    'the native comparison already measured this deviation');
  assert.equal(compareProduct(far, exact, { curved: 'true', exact_vol_rel: '0' }, tolerance).skipped, 'curved');
  const shifted = { ...exact, min: exact.min.map(v => v + 1e-3), max: exact.max };
  assert.equal(compareProduct(shifted, exact, { curved: 'false', exact_vol_rel: '0', exact_bbox_dev_m: '0' }, tolerance).ok, false);
});

test('malformed OBJ is refused rather than measured', () => {
  assert.throws(() => parseObj('v 1 2 nan\n'), /Nonfinite/);
  assert.throws(() => parseObj('f 1 2 3\n'), /before any object/);
  assert.throws(() => productMeasures(parseObj('o a\nv 0 0 0\nf 1 2 3\n').get('a')), /out of range/);
});

test('sourceIdentity maps ids to the type and GlobalId in the STEP source', () => {
  const rows = sourceIdentity("#12=IFCWALL('3k$ab''c',#2,'W',$);\n#13=IFCCARTESIANPOINT((0.,0.,0.));\n#14=IFCWINDOW('gid',#2,$);\n");
  assert.deepEqual(rows.get(12), { type: 'IFCWALL', globalId: "3k$ab'c" });
  assert.equal(rows.get(14).globalId, 'gid');
  assert.equal(rows.get(13), undefined, 'non-rooted entities have no GlobalId');
});
