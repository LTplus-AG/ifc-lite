// SPDX-License-Identifier: MPL-2.0
// Explicit qualification command: requires a caller-selected baseline and built IFCX.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const base = process.argv[2];
if (!base || !/^[0-9a-f]{40}$/u.test(base)) throw Error('Pass the exact 40-character parent commit');
const root = resolve(import.meta.dirname, '..');
const baseline = execFileSync('git', ['show', `${base}:packages/ifcx/src/generated/imported-geometry-static.js`], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
const temporary = mkdtempSync(resolve(root, 'packages/ifcx/.imported-parent-'));
try {
  writeFileSync(join(temporary, 'package.json'), '{"type":"module"}');
  cpSync(resolve(root, 'packages/ifcx/dist'), temporary, { recursive: true, dereference: true });
  writeFileSync(join(temporary, 'generated/imported-geometry-static.js'), baseline);
  globalThis.WebAssembly = undefined;
  const previous = await import(pathToFileURL(join(temporary, 'imported-kernel.js')).href);
  const current = await import(pathToFileURL(resolve(root, 'packages/ifcx/dist/imported-kernel.js')).href);
  const affine = [[2, 0, 0, 0], [1, 3, 0, 0], [0, 0, 4, 0], [1000000, -2000000, 3, 1]];
  const projective = [[1, 0, 0, 1], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const triangle = { points: [[0, 0, 0], [1, 0, 1], [0, 1, 0]], faceVertexIndices: [0, 1, 2], faceVertexCounts: [3], normals: [[-1, 0, 1]] };
  const cases = [
    ['executePoints', [new Float64Array([16777217, 2, 3, 0, -0, -0]), []]],
    ['executePoints', [new Float64Array(), []]],
    ['executePoints', [new Float64Array([1, 2, 3]), [affine, affine]]],
    ['executePoints', [new Float32Array([0, 0, 0, -1, 0, 0]), [projective]]],
    ['executeMesh', [triangle, []]],
    ['executeMesh', [triangle, [affine]]],
    ['executeMesh', [{ points: triangle.points, faceVertexIndices: [4294967296, 1.9, 2], faceVertexCounts: [3] }, []]],
    ['stageTransform', [[affine, affine]]],
    ['stageUvs', [[NaN, Infinity, -Infinity, -0, 16777217]]],
    ['computeNormalMatrix', [new Float32Array(16)]],
    ['computeNormalMatrix', [new Float32Array(affine.flat())]],
    ['computeNormals', [new Float32Array(triangle.points.flat()), new Uint32Array([0, 1, 2])]],
    ['computeNormals', [new Float32Array(9), new Uint32Array([0, 1, 2])]],
  ];
  for (const [name, args] of cases) assert.deepEqual(current[name](...args), previous[name](...args), name);
  for (const api of [current, previous]) assert.throws(() => api.executeMesh({ points: [[-1, 0, 0]], faceVertexIndices: [] }, [projective]), /homogeneous w/);
  const previousConsumer = await import(pathToFileURL(join(temporary, 'index.js')).href);
  const currentConsumer = await import(pathToFileURL(resolve(root, 'packages/ifcx/dist/index.js')).href);
  const fixtureNames = ['Hello_Wall_hello-wall.ifcx', 'Hello_Wall_advanced_3rd-window.ifcx', 'Point_Cloud_point-cloud.ifcx', 'Point_Cloud_S1-pointcloud.ifcx'];
  const fixtures = fixtureNames.map(name => {
    const bytes = readFileSync(resolve(root, 'tests/models/ifc5', name));
    return { name, buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  });
  const fields = result => ({ meshes: result.meshes, pointClouds: result.pointClouds, spatialHierarchy: result.spatialHierarchy, pathToId: result.pathToId, idToPath: result.idToPath, entityCount: result.entityCount, georeferencing: result.georeferencing });
  for (const fixture of fixtures) assert.deepEqual(fields(await currentConsumer.parseIfcx(fixture.buffer)), fields(await previousConsumer.parseIfcx(fixture.buffer)), fixture.name);
  assert.deepEqual(fields(await currentConsumer.parseFederatedIfcx(fixtures.slice(0, 2))), fields(await previousConsumer.parseFederatedIfcx(fixtures.slice(0, 2))), 'federated overlay');
  console.log(JSON.stringify({ realFixtureCases: fixtures.length, federatedCases: 1, baseline: base, baselineStaticSha256: createHash('sha256').update(baseline).digest('hex'), numericalCases: cases.length, errorCases: 1, exactFields: true, WebAssembly: false }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
