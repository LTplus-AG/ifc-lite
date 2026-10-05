/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { readWallMetres } from '@/store/slices/mutation-wall-resize';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { authoringGhosts } from './model-authoring-ghost';
import { authoringReader } from './model-authoring-read';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));

type V3 = [number, number, number];
function bounds(meshes: readonly Pick<MeshData, 'positions'>[]): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], mesh.positions[i + k]); max[k] = Math.max(max[k], mesh.positions[i + k]); }
    }
  }
  return { min, max };
}

test('the ghost of a new wall and its window is the geometry the builders commit, in the storey frame', async () => {
  const { dataStore } = await seedAuthoringSample();
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Annex', units: 'm', frame: 'storey-local', operations: [
    { op: 'element.create', ref: 'w', ifcClass: 'IfcWall', storey: { globalId: GROUND_STOREY }, name: 'Annex',
      params: { start: [10, 10, 0], end: [14, 13, 0], thickness: 0.3, height: 2.8 } },
    { op: 'hosted.create', kind: 'window', host: { ref: 'w' }, offset: 2.5, sill: 0.9, width: 1.2, height: 1.1 },
  ] }));
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  const ghosts = authoringGhosts(useViewerStore.getState(), preview);
  assert.equal(ghosts.length, 2);
  const [wallGhost, windowGhost] = ghosts.map((mesh) => bounds([mesh]));

  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0, 1]), 'test');
  assert.ok(outcome.ok);
  const wallId = dataStore.entities.getExpressIdByGlobalId(outcome.receipt.applied[0].globalId);
  const reader = authoringReader(useViewerStore.getState(), SAMPLE_MODEL)!;
  const created = reader.view.getNewEntities().find((entity) => entity.attributes[0] === outcome.receipt.applied[0].globalId)!;
  assert.equal(wallId, -1, 'a created wall is an overlay entity');
  const wall = readWallMetres(reader, created.expressId)!;
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const plane = buildStoreyWorkplane(useViewerStore.getState(), SAMPLE_MODEL, storey, 0);
  assert.ok(isWorkplane(plane));
  // The committed wall's box, mapped through the same storey workplane.
  const dir = [(wall.end[0] - wall.start[0]) / 5, (wall.end[1] - wall.start[1]) / 5];
  const half = [-dir[1] * wall.thickness / 2, dir[0] * wall.thickness / 2];
  const corners = [-1, 1].flatMap((side) => [wall.start, wall.end].flatMap((p) => [0, wall.height].map((z) =>
    plane.localToRender([p[0] + side * half[0], p[1] + side * half[1], p[2] + z]))));
  const committed = bounds([{ positions: new Float32Array(corners.flat()) }]);
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(wallGhost.min[k] - committed.min[k]) < 1e-3 && Math.abs(wallGhost.max[k] - committed.max[k]) < 1e-3,
      `the wall ghost matches the committed wall on axis ${k}`);
  }
  assert.deepEqual([wall.thickness, wall.height].map((v) => Number(v.toFixed(6))), [0.3, 2.8]);
  // The window ghost sits 0.9 m above the wall base, 1.1 m tall, inside the wall's extent.
  assert.ok(Math.abs(windowGhost.min[1] - (wallGhost.min[1] + 0.9)) < 1e-3 && Math.abs(windowGhost.max[1] - windowGhost.min[1] - 1.1) < 1e-3);
});
