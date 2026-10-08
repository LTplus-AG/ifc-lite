/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { readHostedFill, readHostedElementSize } from '@ifc-lite/create';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { authoringGhosts } from './model-authoring-ghost';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial));
const wasm = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const created = (value: { expressId: number } | { error: string }) => {
  assert.ok('expressId' in value, 'error' in value ? value.error : ''); return value.expressId;
};
function volume(mesh: Pick<MeshData, 'positions' | 'indices'>): number {
  const p = mesh.positions, ids = mesh.indices; let sum = 0;
  for (let i = 0; i < ids.length; i += 3) {
    const a = ids[i] * 3, b = ids[i + 1] * 3, c = ids[i + 2] * 3;
    sum += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return Math.abs(sum);
}
for (const kind of ['door', 'window'] as const)
test(`#7265 real WASM ${kind} hosted edit cuts the resized opening at the bounded preview position`, { skip: !existsSync(wasm) && 'run pnpm build:wasm:fetch' }, async () => {
  const { dataStore, view } = await seedAuthoringSample(), state = useViewerStore.getState();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const host = created(state.addWall(SAMPLE_MODEL, storey, { Start: [20, 20, 0], End: [32, 20, 0], Thickness: .25, Height: 4 }));
  const id = created(useViewerStore.getState().addHostedFill(SAMPLE_MODEL, host, { kind, params: { Offset: 2, Sill: .7, Width: 1, Height: 1.2 } }));
  const saved = await parseIfc(editedModelBytes(dataStore, view)), binding = readHostedFill(saved, id); assert.ok(binding);
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native hosted cut', units: 'm', frame: 'storey-local', operations: [{
    op: 'hosted.edit', target: { modelId: SAMPLE_MODEL, globalId: saved.entities.getGlobalId(id), ifcClass: saved.entities.getTypeName(id), name: saved.entities.getName(id) },
    expected: { ...binding, location: binding.location.map(value => value * getModelLengthUnitScale(saved)), size: readHostedElementSize(saved, id) },
    edit: { Offset: 5, Sill: .5, OverallWidth: 1.3, OverallHeight: 1.6 } }] }));
  const preview = previewModelAuthoring(useViewerStore.getState(), batch); assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native hosted row status');
  const count = view.getMutationCount(), ghosts = authoringGhosts(useViewerStore.getState(), preview); assert.equal(ghosts.length, 1);
  assert.equal(view.getMutationCount(), count, 'the post-edit opening ghost never publishes its native draft');
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'WASM hosted cut'); assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const bytes = editedModelBytes(dataStore, view), reparsed = await parseIfc(bytes);
  assert.equal(readHostedFill(reparsed, id)?.offset, 5); assert.deepEqual(readHostedElementSize(reparsed, id), { OverallWidth: 1.3, OverallHeight: 1.6 });
  initSync({ module: readFileSync(wasm) }); const api = new IfcAPI(); let hostVolume = 0;
  const vertices: number[][] = [];
  try {
    const pre = api.buildPrePassOnce(bytes), [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i); if (!mesh) continue;
        try { if (mesh.expressId === host) {
          const positions = mesh.positions, origin = mesh.origin; hostVolume += volume({ positions, indices: mesh.indices });
          for (let at = 0; at < positions.length; at += 3) vertices.push([positions[at] + origin[0], positions[at + 1] + origin[1], positions[at + 2] + origin[2]]);
        } } finally { mesh.free(); }
      }
    } finally { collection.free(); }
  } finally { api.clearPrePassCache(); api.free(); }
  assert.ok(Math.abs(hostVolume - (12 * .25 * 4 - 1.3 * 1.6 * .25)) < .001, `actual native host volume ${hostVolume} includes resized cut`);
  // The canonical slide preview pads only wall depth; along-wall and vertical
  // bounds must land on actual native cut vertices, rather than claim solid parity.
  for (const axis of [0, 1]) {
    const coordinates = Array.from(ghosts[0].positions).filter((_value, at) => at % 3 === axis);
    for (const edge of [Math.min(...coordinates), Math.max(...coordinates)])
      assert.ok(vertices.some(point => Math.abs(point[axis] - edge) < .001), `native cut has preview edge ${edge} on render axis ${axis}`);
  }
});
