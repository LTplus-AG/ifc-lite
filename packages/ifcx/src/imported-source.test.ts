/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { extractGeometry } from './geometry-extractor.js';
import { importedSourceFor } from './imported-source.js';
import { ATTR, type ComposedNode, type UsdMesh } from './types.js';

function node(path: string, attributes: Record<string, unknown> = {}): ComposedNode {
  return { path, attributes: new Map(Object.entries(attributes)), children: new Map() };
}
const triangle = (): UsdMesh => ({
  points: [[1 + 2 ** -35, 0, 0], [0, 1, 0], [0, 0, 1]],
  faceVertexIndices: [0, 1, 2],
});
const translation = (x: number) => ({ transform: [
  [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [x, 0, 0, 1],
] });

it('retains source coefficients and edge identity before compatible display narrowing', () => {
  const shift = 10_000_000 + 0.125;
  const root = node('root', { [ATTR.CLASS]: { code: 'IfcWall' }, [ATTR.TRANSFORM]: translation(shift) });
  const raw = triangle();
  const body = node('shared', { [ATTR.MESH]: raw });
  root.children.set('Body', body);
  const composed = new Map([[root.path, root], [body.path, body]]);
  const meshes = extractGeometry(composed, new Map([['root', 1]]));
  assert.ok(Array.isArray(meshes)); // public entry is synchronous, without init
  assert.equal(meshes.length, 1);
  const source = importedSourceFor(meshes);
  assert.ok(source);
  assert.equal(importedSourceFor(meshes[0]), source);
  assert.equal(source.occurrences[0].transforms[0][3][0], shift);
  assert.equal(source.occurrences[0].definition.points[0][0], raw.points[0][0]);
  assert.deepEqual(source.occurrences[0].lineage, [
    { path: 'root', edgeName: null }, { path: 'shared', edgeName: 'Body' },
  ]);
  assert.equal(meshes[0].positions[0], Math.fround(Math.fround(shift) + raw.points[0][0]));
  // The internal document owns its numbers even after the adapter is released.
  raw.points[0][0] = 42;
  assert.equal(source.occurrences[0].definition.points[0][0], 1 + 2 ** -35);
});

it('shares raw definitions while retaining two transformed traversal occurrences', () => {
  const first = node('first', { [ATTR.CLASS]: { code: 'IfcWall' }, [ATTR.TRANSFORM]: translation(2) });
  const second = node('second', { [ATTR.CLASS]: { code: 'IfcWall' }, [ATTR.TRANSFORM]: translation(4) });
  const body = node('shared', { [ATTR.MESH]: triangle() });
  first.children.set('FirstBody', body);
  second.children.set('SecondBody', body);
  const composed = new Map([first, second, body].map(item => [item.path, item]));
  const meshes = extractGeometry(composed, new Map([['first', 1], ['second', 2]]));
  assert.equal(meshes.length, 2);
  const source = importedSourceFor(meshes);
  assert.ok(source);
  assert.equal(source.definitions.size, 1);
  assert.equal(source.occurrences.length, 2);
  assert.equal(source.occurrences[0].definition, source.occurrences[1].definition);
  assert.equal(source.occurrences[0].lineage[1].edgeName, 'FirstBody');
  assert.equal(source.occurrences[1].lineage[1].edgeName, 'SecondBody');
  assert.deepEqual(meshes.map(mesh => mesh.expressId), [1, 2]);
  assert.deepEqual(meshes.map(mesh => mesh.positions[0]), [3, 5]);
});

it('retains inline point source before the legacy float32 input stage', async () => {
  const { extractPointClouds } = await import('./pointcloud-extractor.js');
  const raw = 10_000_000 + 0.125;
  const scan = node('scan', {
    [ATTR.CLASS]: { code: 'IfcGeographicElement' },
    'points::array': { positions: [[raw, 2, 3]], colors: [[0.1, 0.2, 0.3]] },
    [ATTR.TRANSFORM]: translation(-10_000_000),
  });
  const clouds = extractPointClouds(new Map([['scan', scan]]), new Map([['scan', 7]]));
  assert.equal(clouds.length, 1);
  const source = importedSourceFor(clouds[0].positions);
  assert.ok(source);
  assert.equal(source.pointOccurrences[0].definition.positions[0], raw);
  assert.equal(source.pointOccurrences[0].definition.sourceEncoding, 'points-array');
  assert.equal(source.pointOccurrences[0].definition.sourcePrecision, 'f64');
  // Compatible output intentionally rounds before placement, while source retains .125.
  assert.deepEqual([...clouds[0].positions], [0, 3, -2]);
  assert.deepEqual(clouds[0].bbox, { min: [0, 3, -2], max: [0, 3, -2] });
  assert.deepEqual(clouds[0].colors, new Float32Array([0.1, 0.2, 0.3]));
});

it('Rust reaches raw geometry and image sources only after visibility and type eligibility', () => {
  const hidden = node('hidden', {
    [ATTR.CLASS]: { code: 'IfcWall' },
    [ATTR.VISIBILITY]: { visibility: 'invisible' },
    // Intentionally malformed source must remain unadmitted while hidden.
    [ATTR.MESH]: { points: null, faceVertexIndices: null },
    'ifclite::appearance::v1': { image: { ref: 'missing' }, uvs: null },
  });
  const type = node('type', {
    [ATTR.CLASS]: { code: 'IfcWallType' },
    customdata: { originalStepInstance: '#1=IFCWALLTYPE()' },
    [ATTR.MESH]: { points: null },
  });
  assert.deepEqual(extractGeometry(new Map([['hidden', hidden], ['type', type]]),
    new Map([['hidden', 1], ['type', 2]])), []);
});

it('iterative owned geometry traversal preserves a long acyclic source lineage', () => {
  const root = node('root', { [ATTR.CLASS]: { code: 'IfcWall' } });
  const nodes = [root];
  let parent = root;
  for (let i = 0; i < 512; i++) {
    const child = node(`body-${i}`);
    parent.children.set('next', child);
    nodes.push(child); parent = child;
  }
  parent.attributes.set(ATTR.MESH, triangle());
  const meshes = extractGeometry(new Map(nodes.map(item => [item.path, item])), new Map([['root', 1]]));
  assert.equal(meshes.length, 1);
  assert.deepEqual([...meshes[0].indices], [0, 1, 2]);
  assert.equal(importedSourceFor(meshes)?.occurrences[0].lineage.length, 513);
});

it('preserves isolated UTF16 source paths, edges and dedup keys without replacement', () => {
  const root = node('/\ud800', { [ATTR.CLASS]: { code: 'IfcWall' } });
  const replacement = node('/\ufffd', { [ATTR.MESH]: triangle() });
  const second = node('/second\ud800', { [ATTR.MESH]: triangle() });
  root.children.set('edge\ud800', replacement);
  root.children.set('edge\ufffd', second);
  const meshes = extractGeometry(new Map([root, replacement, second].map(item => [item.path, item])),
    new Map([[root.path, 1]]));
  assert.equal(meshes.length, 2);
  const source = importedSourceFor(meshes);
  // Pair each path with its own edge so the check is independent of emission order.
  const pairs = (source?.occurrences ?? []).map(item => [item.path, item.lineage[1].edgeName] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  assert.deepEqual(pairs, [['/second\ud800', 'edge\ufffd'], ['/\ufffd', 'edge\ud800']]);
});

it('dedupes aliases by resolved colour and keeps differently styled occurrences', () => {
  const build = (colorB: number[]) => {
    const root = node('root', { [ATTR.CLASS]: { code: 'IfcWall' } });
    const a = node('a', { [ATTR.DIFFUSE_COLOR]: [1, 0, 0] });
    const b = node('b', { [ATTR.DIFFUSE_COLOR]: colorB });
    const shared = node('shared', { [ATTR.MESH]: triangle() });
    root.children.set('a', a); root.children.set('b', b);
    a.children.set('s', shared); b.children.set('s', shared);
    return extractGeometry(new Map([root, a, b, shared].map(item => [item.path, item])), new Map([['root', 1]]));
  };
  assert.equal(build([1, 0, 0]).length, 1);
  const styled = build([0, 0, 1]);
  assert.equal(styled.length, 2);
  assert.deepEqual(styled.map(m => m.color).sort(), [[0, 0, 1, 1], [1, 0, 0, 1]]);
});

it('attributes meshes to the closest ancestor-or-self entity and skips entity-less meshes', () => {
  const wall = node('wall', { [ATTR.CLASS]: { code: 'IfcWall' } });
  const plain = node('plain');
  const inner = node('inner', { [ATTR.CLASS]: { code: 'IfcBeam' } });
  const deepMesh = node('deep', { [ATTR.MESH]: triangle() });
  const innerMesh = node('innerMesh', { [ATTR.MESH]: triangle() });
  const orphan = node('orphan', { [ATTR.MESH]: triangle() });
  wall.children.set('p', plain); plain.children.set('m', deepMesh);
  plain.children.set('i', inner); inner.children.set('m', innerMesh);
  const all = [wall, plain, inner, deepMesh, innerMesh, orphan];
  const meshes = extractGeometry(new Map(all.map(item => [item.path, item])),
    new Map([['wall', 1], ['inner', 2]]));
  const byId = meshes.map(m => [m.expressId, m.ifcType]).sort();
  assert.deepEqual(byId, [[1, 'IfcWall'], [2, 'IfcBeam']]);
});

it('matches the composed cycle stub seed order when an independent root exists', async () => {
  const { composeIfcx } = await import('./composition.js');
  const composed = composeIfcx({ header: { id: '', ifcxVersion: 'ifcx_alpha', dataVersion: '', author: '', timestamp: '' },
    imports: [], schemas: {}, data: [
      { path: 'A', children: { B: 'B' }, attributes: { [ATTR.CLASS]: { code: 'IfcWall' }, [ATTR.MESH]: triangle() } },
      { path: 'B', children: { A: 'A' }, attributes: { [ATTR.CLASS]: { code: 'IfcWall' }, [ATTR.MESH]: triangle() } },
      { path: 'R', attributes: { [ATTR.CLASS]: { code: 'IfcWall' }, [ATTR.MESH]: triangle() } },
    ] });
  assert.deepEqual(extractGeometry(composed, new Map([['A', 1], ['B', 2], ['R', 3]])).map(mesh => mesh.expressId), [3, 1, 2]);
});

it('retains one decoded point source for repeated source-definition occurrences', async () => {
  const { extractPointClouds } = await import('./pointcloud-extractor.js');
  const root = node('root', { [ATTR.CLASS]: { code: 'IfcGeographicElement' } });
  const cloud = node('cloud', { 'points::array': { positions: [[1 + 2 ** -35, 2, 3]] } });
  root.children.set('one', cloud); root.children.set('two', cloud);
  const clouds = extractPointClouds(new Map([['root', root], ['cloud', cloud]]), new Map([['root', 1]]));
  assert.equal(clouds.length, 2, 'point occurrences retain their original non-deduplicated output');
  const source = importedSourceFor(clouds);
  assert.ok(source);
  assert.equal(source.pointDefinitions.size, 1);
  assert.equal(source.pointOccurrences[0].definition, source.pointOccurrences[1].definition);
  assert.notEqual(clouds[0].positions, clouds[1].positions);
});

it('retained authored matrices and presentation facts cannot change through the caller source', () => {
  const transform = translation(5);
  const color = [0.2, 0.3, 0.4];
  const entity = node('entity', { [ATTR.CLASS]: { code: 'IfcWall' }, [ATTR.TRANSFORM]: transform,
    [ATTR.DIFFUSE_COLOR]: color, [ATTR.MESH]: triangle() });
  const meshes = extractGeometry(new Map([['entity', entity]]), new Map([['entity', 1]]));
  const source = importedSourceFor(meshes)!;
  transform.transform[3][0] = 99;
  color[0] = 1;
  const retainedTransform = source.nodes.get('entity')!.attributes.get(ATTR.TRANSFORM) as { transform: number[][] };
  assert.equal(retainedTransform.transform[3][0], 5);
  assert.deepEqual(source.nodes.get('entity')!.attributes.get(ATTR.DIFFUSE_COLOR), [0.2, 0.3, 0.4]);
  assert.equal(source.occurrences[0].transforms[0][3][0], 5);
  assert.equal(meshes[0].positions[0], 6);
  assert.deepEqual(meshes[0].color, [0.2, 0.3, 0.4, 1]);
});

it('keeps a mesh without faceVertexIndices (or with only optional arrays missing) from aborting the import', () => {
  const root = node('root', { [ATTR.CLASS]: { code: 'IfcWall' } });
  const bare = node('bare', { [ATTR.MESH]: { points: triangle().points } });
  const good = node('good', { [ATTR.MESH]: triangle() });
  root.children.set('Bare', bare);
  root.children.set('Good', good);
  const composed = new Map([root, bare, good].map(item => [item.path, item]));
  const meshes = extractGeometry(composed, new Map([['root', 1]]));
  assert.equal(meshes.length, 2);
  const byIndices = meshes.map(mesh => mesh.indices.length).sort();
  assert.deepEqual(byIndices, [0, 3]);
  for (const mesh of meshes) assert.equal(mesh.positions.length, 9);
});
