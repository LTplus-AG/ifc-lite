/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { resolvePlacementChain } from '@/lib/placement-core';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { readSplitSnapshot } from './model-authoring-split-state';
import { authoringSplitMarker } from './model-authoring-split-ghost';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const wasm = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const range = (values: number[]) => [Math.min(...values), Math.max(...values)];
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < .001, `${actual} must be within1mm of ${expected}`);

for (const kind of ['wall', 'linear', 'slab'] as const) test(`#7251 native WASM cut faces locate the ${kind} marker and preserve section roll`, { skip: !existsSync(wasm) && 'run pnpm build:wasm:fetch' }, async () => {
  const { dataStore, view } = await seedAuthoringSample(), state = () => useViewerStore.getState();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const created = kind === 'wall'
    ? state().addWall(SAMPLE_MODEL, storey, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: .2, Height: 3 })
    : kind === 'linear' ? state().addBeam(SAMPLE_MODEL, storey, { Start: [0, 8, 1], End: [8, 8, 3], Profile: { Type: 'RectangleHollow', XDim: .4, YDim: .3, WallThickness: .02 } })
      : state().addSlab(SAMPLE_MODEL, storey, { Profile: 'polygon', OuterCurve: [[0, 0], [8, 0], [8, 3], [4, 3], [4, 6], [0, 6]], Position: [0, 16, 0], Thickness: .2 });
  assert.ok(!('error' in created), 'public native creation must succeed before testing a split');
  const id = created.expressId, ctx = modelEditTarget(state(), SAMPLE_MODEL)!;
  if (kind === 'linear') {
    const placement = resolvePlacementChain(dataStore, view, ctx.editor, id); assert.ok(placement);
    const direction = ctx.editor.addEntity('IfcDirection', [[.3, 1, -1.2]]).expressId;
    ctx.editor.setPositionalAttribute(placement.axisPlacementId, 2, `#${direction}`);
  }
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  const empty = new MutablePropertyView(saved.properties, SAMPLE_MODEL), expected = readSplitSnapshot(saved, new StoreEditor(saved, empty), id, 'm');
  assert.equal(expected.kind, kind);
  const cut = kind === 'slab' ? { kind, a: [2, 15], b: [2, 23] } : { kind, distance: 2 };
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Actual native cut', units: 'm', frame: 'storey-local', operations: [{ op: 'element.split', target: { modelId: SAMPLE_MODEL, globalId: saved.entities.getGlobalId(id), ifcClass: saved.entities.getTypeName(id), name: saved.entities.getName(id) }, expected, cut }] }));
  const preview = previewModelAuthoring(state(), batch); assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native split preview must be ready');
  const marker = authoringSplitMarker(state(), batch, preview.rows[0], -123); assert.ok(marker);
  const plane = buildStoreyWorkplane(state(), SAMPLE_MODEL, storey, 0); assert.ok(isWorkplane(plane));
  const axis = kind !== 'linear' ? [1, 0, 0] : [8 / Math.hypot(8, 2), 0, 2 / Math.hypot(8, 2)];
  const start = kind !== 'linear' ? [0, 0, 0] : [0, 8, 1];
  const project = (point: [number, number, number]) => dot(plane.renderToLocal(point).map((value, index) => value - start[index]), axis);
  const markerCoordinates: number[] = [];
  for (let at = 0; at < marker.positions.length; at += 3) markerCoordinates.push(project([marker.positions[at], marker.positions[at + 1], marker.positions[at + 2]]));
  const markerRange = range(markerCoordinates); near(markerRange[0], kind === 'slab' ? 1.995 : 2); near(markerRange[1], kind === 'slab' ? 2.005 : 2.01);
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'Actual native cut'); assert.ok(outcome.ok);
  const bytes = editedModelBytes(dataStore, view), after = await parseIfc(bytes);
  const addedIds = [...after.entityIndex.byId.values()].filter(row => row.type === (kind === 'wall' ? 'IFCWALL' : kind === 'linear' ? 'IFCBEAM' : 'IFCSLAB') && !saved.entityIndex.byId.has(row.expressId)).map(row => row.expressId);
  assert.equal(addedIds.length, 1, 'native export has exactly one new product in the split class');
  const added = addedIds[0];
  initSync({ module: readFileSync(wasm) });
  const api = new IfcAPI(), points = new Map<number, [number, number, number][]>();
  try {
    const pre = api.buildPrePassOnce(bytes), rtc = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const meshes = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, rtc[0], rtc[1], rtc[2], pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try { for (let index = 0; index < meshes.length; index++) {
      const mesh = meshes.get(index); if (!mesh) continue;
      try { if (mesh.expressId === id || mesh.expressId === added) {
        const collected = points.get(mesh.expressId) ?? [], p = mesh.positions, origin = mesh.origin;
        for (let at = 0; at < p.length; at += 3) collected.push([p[at] + origin[0], p[at + 1] + origin[1], p[at + 2] + origin[2]]);
        points.set(mesh.expressId, collected);
      } } finally { mesh.free(); }
    } } finally { meshes.free(); }
  } finally { api.clearPrePassCache(); api.free(); }
  assert.equal(points.size, 2, 'both exported native pieces have actual WASM meshes');
  const left = range(points.get(added)!.map(project)), right = range(points.get(id)!.map(project));
  near(left[0], 0); near(left[1], 2); near(right[0], 2); near(right[1], kind !== 'linear' ? 8 : Math.hypot(8, 2));
  if (kind === 'linear') {
    // Independent actual cut-face vertices must retain the declared rolled
    // rectangle, rather than merely agreeing with another preview resolver.
    const face = [...points.values()].flat().filter(point => Math.abs(project(point) - 2) < .001);
    assert.ok(face.length > 0);
    for (const [direction, extent] of [[expected.placement.frame.x, .2], [expected.placement.frame.y, .15]] as const) {
      const values = face.map(point => dot(plane.renderToLocal(point).map((value, index) => value - start[index] - axis[index] * 2), direction));
      const actual = range(values); near(actual[0], -extent); near(actual[1], extent);
    }
  }
});
