import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, it } from 'node:test';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { SAMPLE_MODEL as MODEL, GROUND_STOREY, seedAuthoringSample, parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { toGlobalIdFromModels } from '@/store/globalId';
import { setRequestRemesh, type RemeshRequest } from '../transaction';
import { commandPointerMove, commandPointerDown, writeCommandField, commitCommand, getCommandRuntime } from '../runtime';
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
  return new StepExporter(s.models.get(MODEL)!.ifcDataStore!, s.mutationViews.get(MODEL)!).export({ schema: 'IFC4', applyMutations: true }).content;
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

for (const side of [-1,1]) it(`#9296 Offset exports a 5m parallel wall at y=${side*1.5}, and undoes once`, async () => {
  const id = wall(0), d = depth(), before = exported(); select(id);
  await useViewerStore.getState().startCommand('element.offset');
  assert.equal(getCommandRuntime().command?.id, 'element.offset');
  writeCommandField(0,1.5); click(2,side*2);
  assert.equal(getCommandRuntime().command,null);
  const { resolveEntityRef } = await import('@/store/resolveEntityRef');
  const copied = resolveEntityRef(useViewerStore.getState().selectedEntityId!).expressId;
  assert.notEqual(copied,id);
  const ends = useViewerStore.getState().readWallEndpoints(MODEL,copied)!;
  assert.ok(Math.abs(ends.start[1]-side*1.5)<.001, JSON.stringify(ends));
  assert.ok(Math.abs(Math.hypot(ends.end[0]-ends.start[0],ends.end[1]-ends.start[1])-5)<.001);
  const frame = await exportedPosition(copied);
  assert.ok(Math.abs(frame.origin[1]-side*1.5)<.001);
  useViewerStore.getState().undo(MODEL); assert.equal(depth(),d); assert.deepEqual(exported(),before);
});
it('#9296 Offset refuses a non-wall and invalid distances without changing the graph', async () => {
  const column = useViewerStore.getState().addColumn(MODEL,storey,{ Position: [0,0,0], Width: .3, Depth: .3, Height: 3 });
  assert.ok('expressId' in column); select(column.expressId);
  let before = exported(); await useViewerStore.getState().startCommand('element.offset'); assert.equal(commitCommand(),false); assert.deepEqual(exported(),before);
  const id = wall(0); select(id); await useViewerStore.getState().startCommand('element.offset'); before=exported();
  for (const value of [0,-1]) { writeCommandField(0,value); assert.equal(commitCommand(),false); assert.deepEqual(exported(),before); }
});
