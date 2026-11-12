// SPDX-License-Identifier: MPL-2.0
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, it } from 'node:test';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { SAMPLE_MODEL as MODEL, GROUND_STOREY, seedAuthoringSample, parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { toGlobalIdFromModels } from '@/store/globalId';
import { setRequestRemesh, type RemeshRequest } from '../transaction';
import { commandPointerMove, commandPointerDown, writeCommandField, commitCommand, getCommandRuntime, updateCommandGesture } from '../runtime';
import type { SnapResult } from '@/lib/snap/types';
import '../builtin';

let storey: number;
let restore: () => void;
let remeshed: RemeshRequest[];
beforeEach(async () => {
  const { dataStore } = await seedAuthoringSample();
  storey = [...dataStore.entities.expressId].find(id => dataStore.entities.getGlobalId(id) === GROUND_STOREY)!;
  useViewerStore.setState({ workspaceMode: 'view', session: null, activeTool: 'select' });
  assert.ok(useViewerStore.getState().enterModelWorkspace({ modelId: MODEL, storeyId: storey }));
  remeshed = [];
  restore = setRequestRemesh((_get, request) => { remeshed.push(request); });
});
afterEach(() => { restore(); useViewerStore.getState().exitModelWorkspace(); });
function wall(y = 10, end: [number, number] = [5, y]) {
  const r = useViewerStore.getState().addWall(MODEL, storey, { Start: [0,y,0], End: [...end,0], Thickness: .2, Height: 3 });
  assert.ok('expressId' in r); return r.expressId;
}
function select(...ids: number[]) {
  const s = useViewerStore.getState();
  s.setSelectedEntityIds(ids.map(id => toGlobalIdFromModels(s.models, MODEL, id)));
}
function at(x: number, y: number, alt = false): SnapResult {
  const plane = getCommandRuntime().ctx?.workplane; assert.ok(plane);
  return { local: [x,y], render: plane.localToRender([x,y,0]), winner: null, guides: [], locked: false, modifiers: { alt, shift: false } };
}
function click(x: number, y: number, alt = false) { commandPointerMove(at(x,y,alt)); commandPointerDown(at(x,y,alt)); }
function exported() {
  const s = useViewerStore.getState();
  return new StepExporter(s.models.get(MODEL)!.ifcDataStore!, s.mutationViews.get(MODEL)!).export({ schema: 'IFC4', applyMutations: true, timeStamp: '20260101T000000' }).content;
}
const depth = () => useViewerStore.getState().undoStacks.get(MODEL)?.length ?? 0;
async function exportedPosition(id: number) {
  // Resolve the actual exported placement chain, not the live store's cached read.
  const { uprightFrame } = await import('../../../../../../../packages/create/src/in-store/element-transform-frames');
  const { MutablePropertyView } = await import('@ifc-lite/mutations');
  const dataStore = await parseIfc(exported());
  const view = new MutablePropertyView(dataStore.properties ?? null, MODEL);
  const { configureMutationView } = await import('@/utils/configureMutationView');
  configureMutationView(view, dataStore);
  const { AnchorEntityReader } = await import('../../../../../../../packages/create/src/in-store/resolve-anchor');
  const reader = new AnchorEntityReader(dataStore, view);
  const placement = Number(String(reader.entity(id)!.attributes[5]).slice(1));
  const frame = uprightFrame({ dataStore, view }, placement);
  assert.ok(frame); return frame;
}

it('#9296 Mirror typed horizontal axis exports y=14, flips door handedness and undoes once', async () => {
  const id = wall();
  const door = useViewerStore.getState().addHostedFill(MODEL, id, { kind: 'door', params: { Offset: 1, Width: .9, Height: 2.1, OperationType: 'SINGLE_SWING_LEFT' } });
  assert.ok('expressId' in door);
  select(id);
  const before = exported(), d = depth();
  await useViewerStore.getState().startCommand('element.mirror');
  assert.equal(getCommandRuntime().command?.id, 'element.mirror');
  click(0,12); writeCommandField(0,0); assert.ok(commitCommand());
  const text = new TextDecoder().decode(exported());
  assert.deepEqual(danglingReferences(text), []);
  assert.match(text, /SINGLE_SWING_RIGHT/);
  const frame = await exportedPosition(id);
  assert.ok(Math.abs(frame.origin[1] - 14) < .001, JSON.stringify(frame));
  assert.ok(remeshed.some(r => r.expressIds.includes(id) && r.cause === 'hostsChanged'));
  useViewerStore.getState().undo(MODEL);
  assert.equal(depth(), d);
  assert.deepEqual(exported(), before);
});
for (const copy of ['alt','toggle'] as const) it(`#9296 Mirror ${copy} makes a reflected copy and one undo removes it`, async () => {
  const id = wall(), d = depth(); select(id);
  await useViewerStore.getState().startCommand('element.mirror');
  click(0,12);
  if (copy === 'toggle') updateCommandGesture(g => ({ ...(g as import('./element-mirror').MirrorGesture), copy: true }));
  click(4,12,copy === 'alt');
  assert.equal(getCommandRuntime().command, null);
  const selected = useViewerStore.getState().selectedEntityId!;
  const { resolveEntityRef } = await import('@/store/resolveEntityRef');
  const copied = resolveEntityRef(selected).expressId;
  assert.notEqual(copied,id);
  const frame = await exportedPosition(copied);
  assert.ok(Math.abs(frame.origin[1]-14)<.001);
  useViewerStore.getState().undo(MODEL); assert.equal(depth(),d);
});
it('#9296 Mirror previews reflected geometry and reversed winding without changing IFC', async () => {
  const id = wall(); select(id);
  await useViewerStore.getState().startCommand('element.mirror');
  const ctx = getCommandRuntime().ctx!;
  const plane = ctx.workplane!;
  const points = [[0,10,0],[5,10,0],[0,11,0]].flatMap(p => [...plane.localToRender([p[0],p[1],p[2]])]);
  const state = useViewerStore.getState(), model = state.models.get(MODEL)!;
  const meshes = [{ expressId: toGlobalIdFromModels(state.models,MODEL,id), positions: new Float32Array(points), normals: new Float32Array([0,1,0,0,1,0,0,1,0]), indices: new Uint32Array([0,1,2]), color: [1,1,1,1] as [number,number,number,number] }];
  useViewerStore.setState({ models: new Map([[MODEL,{ ...model, geometryResult: { ...model.geometryResult!, meshes } }]]) });
  const before = exported(); click(0,12); commandPointerMove(at(4,12));
  const runtime = getCommandRuntime();
  const ghosts = runtime.command!.ghost!(runtime.gesture,ctx);
  assert.equal(ghosts.length,1); assert.deepEqual([...ghosts[0].indices],[0,2,1]);
  const y = ghosts[0].positions;
  assert.ok(Math.abs(plane.renderToLocal([y[0],y[1],y[2]])[1]-14)<.001);
  assert.deepEqual([...meshes[0].indices],[0,1,2]); assert.deepEqual(exported(),before);
});
it('#9296 Mirror refuses grids atomically and preserves every selected wall', async () => {
  const id = wall();
  useViewerStore.getState().startCommand('grid.place'); click(20,20); click(25,25);
  const grid = useViewerStore.getState().mutationViews.get(MODEL)!.getNewEntities().find(e=>e.type.toUpperCase()==='IFCGRID');
  assert.ok(grid); select(id,grid.expressId);
  const before = exported(); await useViewerStore.getState().startCommand('element.mirror');
  click(0,12); writeCommandField(0,0); assert.equal(commitCommand(),false); assert.deepEqual(exported(),before);
});
