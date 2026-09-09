/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { IfcParser, EntityExtractor, unwrapIfcZipWithResources } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { prepareAppearanceSerialization } from './serialization.js';
import { createExportAdapter } from '@/sdk/adapters/export-adapter.js';
import { exportChangedModelToStep } from '../export/changed-model-export.js';
import type { AppearancePreview, Renderer } from '@ifc-lite/renderer';
import { expandAppearanceCorners } from '@ifc-lite/renderer';
import { AppearancePreviewController } from '../../../../../packages/renderer/src/appearance-preview.js';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { appearanceAssets, modelAppearanceAssets } from './model-assets.js';
import { AppearancePreviewSession } from './preview.js';
import type { AppearanceCommitOptions } from './command.js';
import { appearanceRevision, captureAppearanceSource, commitAppearance } from './command.js';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter.js';
import type { AppearancePlan } from './planner-types.js';

const MODEL = 'appearance-command';
const owner = { kind: 'draft' as const, id: 'command-fixture' };
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));

afterEach(() => {
  mock.restoreAll();
  useViewerStore.getState().clearAllMutations();
  useViewerStore.setState({ models: new Map(), mutationViews: new Map(), geometryResult: null });
  modelAppearanceAssets.clear();
  appearanceAssets.clear();
});

async function applyNext(f: Awaited<ReturnType<typeof fixture>>, marker: number) {
  // Distinct valid PNG: add a checksummed text chunk before IEND.
  const text = Buffer.from(`tEXtMarker\0${marker}`);
  const chunk = Buffer.alloc(text.length + 8);
  chunk.writeUInt32BE(text.length - 4, 0); text.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(text), text.length + 4);
  const asset = await appearanceAssets.add(Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]), { owner });
  const next = f.view.peekNextExpressId(), offset = next - f.plan.nextExpressId;
  const rebase = (value: import('@ifc-lite/mutations').IfcAttributeValue): import('@ifc-lite/mutations').IfcAttributeValue => {
    if (Array.isArray(value)) return value.map(rebase);
    if (typeof value === 'string' && /^#[0-9]+$/.test(value) && Number(value.slice(1)) >= f.plan.nextExpressId) {
      return `#${Number(value.slice(1)) + offset}`;
    }
    return value;
  };
  const plan: AppearancePlan = { ...f.plan, sourceRevision: appearanceRevision(MODEL), nextExpressId: next,
    nextAvailableExpressId: next + 5,
    created: f.plan.created.map(entity => ({ ...entity, expressId: entity.expressId + offset, attributes: entity.attributes.map(rebase) })),
    edits: f.plan.edits.map(edit => ({ ...edit, value: rebase(edit.value) })),
    removed: f.view.getNewEntities().filter(entity => entity.type === 'IfcIndexedTriangleTextureMap').map(entity => entity.expressId),
  };
  plan.created[0].attributes[5] = asset.exportName;
  const groups = [{ ...f.groups[0], parts: [{ ...f.parts()[0], color: [1, 1, 1, 1] as [number, number, number, number],
    texture: { width: 1, height: 1, repeatS: true, repeatT: true, rgba: new Uint8Array([marker, 0, 255, 255]) } }] }];
  const preview = new AppearancePreviewSession(f.renderer); preview.stage(groups);
  await commitAppearance(MODEL, asset.id, plan, f.renderer, preview, groups, captureAppearanceSource(f.view));
  return { asset, plan };
}

async function fixture(viewModelId = MODEL, expanded = false) {
  const source = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Command rollback fixture'),'2;1');
FILE_NAME('command.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,(#6),#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#5,$);
#10=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.)));
#11=IFCTRIANGULATEDFACESET(#10,$,.F.,((1,2,3),(1,3,4)),$);
#13=IFCCOLOURRGB($,1.,0.,0.);
#14=IFCSURFACESTYLERENDERING(#13,0.,$,$,$,$,$,$,.NOTDEFINED.);
#15=IFCSURFACESTYLE($,.BOTH.,(#14));
#19=IFCSTYLEDITEM(#11,(#15),$);
#23=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#11));
#24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#25=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000a',$,'Surface',$,$,$,#24,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;`);
  const data = await new IfcParser().parseColumnar(source.buffer);
  const view = new MutablePropertyView(data.properties, viewModelId);
  const editor = new StoreEditor(data, view);
  const before: MeshData = {
    expressId: 25, geometryItemId: 11,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    color: [1, 0, 0, 1], uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    texture: { width: 1, height: 1, repeatS: true, repeatT: true, rgba: new Uint8Array([255, 0, 0, 255]) },
  };
  before.appearanceSource = { kind: 'canonical-item', indices: before.indices, sourceIndices: before.indices };
  const after: MeshData = { ...(expanded ? expandAppearanceCorners(before, before.indices, [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], before.indices, Array.from(before.indices).flatMap(index => Array.from(before.normals.subarray(index * 3, index * 3 + 3))), before.positions.length / 3) : before), color: [1, 1, 1, 1],
    texture: { width: 1, height: 1, repeatS: true, repeatT: true, rgba: new Uint8Array([0, 0, 255, 255]) } };
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } };
  const geometry: GeometryResult = { meshes: [before], totalTriangles: 2, totalVertices: 4,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
  const model = { ...fixtureModel(MODEL), loadedAt: 1, ifcDataStore: data, geometryResult: geometry };
  useViewerStore.setState({ models: new Map([[MODEL, model]]), activeModelId: MODEL,
    geometryResult: geometry, mutationViews: new Map([[MODEL, view]]), storeEditors: new Map([[MODEL, editor]]),
    undoStacks: new Map(), redoStacks: new Map(), dirtyModels: new Set(), mutationVersion: 0, collabRoomId: null });
  const asset = await appearanceAssets.add(png, { owner });
  const next = view.peekNextExpressId();
  const plan: AppearancePlan = {
    sourceRevision: appearanceRevision(MODEL), nextExpressId: next, nextAvailableExpressId: next + 5,
    created: [
      { expressId: next, type: 'IfcImageTexture', attributes: [true, true, 'DIFFUSE', null, null, asset.exportName] },
      { expressId: next + 1, type: 'IfcTextureVertexList', attributes: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
      { expressId: next + 2, type: 'IfcIndexedTriangleTextureMap', attributes: [[`#${next}`], '#11', `#${next + 1}`, [[1, 2, 3], [1, 3, 4]]] },
      { expressId: next + 3, type: 'IfcSurfaceStyleWithTextures', attributes: [[`#${next}`]] },
      { expressId: next + 4, type: 'IfcSurfaceStyle', attributes: [null, '.BOTH.', [`#${next + 3}`]] },
    ], edits: [{ expressId: 19, index: 1, value: [`#${next + 4}`] }], removed: [], items: [], exclusions: [],
  };
  // Actual preview controller; the adapter measures live resource ownership and
  // injects only GPU boundaries, never the IFC/editor/history implementation.
  type Resource = { released: boolean };
  let currentParts: readonly MeshData[] = [before];
  let currentResources: readonly Resource[] = [{ released: false }];
  const resources = [...currentResources];
  let failStage = false, failConsume = false;
  const controller = new AppearancePreviewController<Resource>({
    capture: () => ({ parts: currentParts, resources: currentResources }),
    stage: parts => {
      if (failStage) throw new Error('GPU allocation refused');
      const created = parts.map(() => ({ released: false }));
      resources.push(...created);
      return created;
    },
    install: (_target, parts, gpu) => { currentParts = parts; currentResources = gpu; },
    release: gpu => { for (const resource of gpu) resource.released = true; },
  });
  const api: AppearancePreview = {
    begin: target => controller.begin(target), update: (token, parts) => controller.update(token, parts),
    cancel: token => controller.cancel(token), commit: token => controller.commit(token),
    prepareCommit: tokens => {
      const commit = controller.prepareCommit(tokens);
      return () => { if (failConsume) throw new Error('GPU token invalidated'); return commit(); };
    },
  };
  const renderer = { getAppearancePreview: () => api,
    getScene: () => ({ getMeshDataPieces: (expressId: number, modelIndex?: number) => currentParts.filter(part =>
      part.expressId === expressId && (modelIndex === undefined || part.modelIndex === modelIndex)) }), requestRender: () => {},
  } as unknown as Renderer;
  const groups = [{ globalId: 25, modelIndex: 0, parts: [after] }];
  const sourceCheckpoint = captureAppearanceSource(view);
  const preview = new AppearancePreviewSession(renderer);
  preview.stage(groups);
  const exported = () => new StepExporter(data, view).export({ schema: 'IFC4', applyMutations: true }).content;
  const assertUncommitted = (initial: ReturnType<typeof snapshot>) => {
    assert.deepEqual(snapshot(), initial);
    assert.strictEqual(useViewerStore.getState().models.get(MODEL)?.geometryResult, geometry);
    assert.strictEqual(useViewerStore.getState().geometryResult, geometry);
    assert.deepEqual(currentParts[0].texture?.rgba, before.texture?.rgba);
    assert.equal(modelAppearanceAssets.exportResources(MODEL).resources.size, 0);
    appearanceAssets.releaseOwner(owner);
    assert.equal(appearanceAssets.get(asset.id), undefined, 'failed command leaked no model/history image lease');
    assert.equal(resources.filter(resource => !resource.released).length, 1, 'only original GPU resource remains');
  };
  const snapshot = () => ({ history: structuredClone(view.getMutations()), next: view.peekNextExpressId(),
    exported: exported(), undo: [...useViewerStore.getState().undoStacks], redo: [...useViewerStore.getState().redoStacks],
    version: useViewerStore.getState().mutationVersion });
  return { asset, plan, view, editor, renderer, preview, groups, before, after, geometry, snapshot, assertUncommitted,
    parts: () => currentParts, failStage: (value: boolean) => { failStage = value; }, failConsume: (value: boolean) => { failConsume = value; },
    commit: (options?: AppearanceCommitOptions) => commitAppearance(MODEL, asset.id, plan, renderer, preview, groups, sourceCheckpoint, options) };
}

describe('appearance command atomicity #4243', () => {
  it('portable export omits history-only authored rows and images without changing Undo/Redo (#4243)', async () => {
    const f = await fixture(); await f.commit();
    const second = await applyNext(f, 2);
    const before = f.snapshot();
    const data = useViewerStore.getState().models.get(MODEL)!.ifcDataStore!;
    const artifact = await exportChangedModelToStep(MODEL, data, f.view,
      { schema: 'IFC4', scheduleState: null, description: 'history export' });
    assert.ok(artifact.content instanceof Uint8Array);
    const archive = await unwrapIfcZipWithResources(new Uint8Array(artifact.content).buffer);
    const parsed = await new IfcParser().parseColumnar(archive.model);
    for (const entity of f.plan.created) assert.equal(parsed.entityIndex.byId.has(entity.expressId), false,
      `superseded authored row #${entity.expressId} became a permanent imported orphan`);
    for (const entity of second.plan.created) assert.equal(parsed.entityIndex.byId.has(entity.expressId), true);
    assert.equal(archive.originalResources.size, 1);
    const snapshot = prepareAppearanceSerialization(MODEL, data, f.view);
    assert.equal(snapshot.view!.peekNextExpressId(), f.view.peekNextExpressId(), 'planning keeps the live allocator watermark');
    const planningBytes = new StepExporter(data, snapshot.view).export({ schema: 'IFC4', applyMutations: true }).content;
    const planningIfc = await new IfcParser().parseColumnar(new Uint8Array(planningBytes).buffer);
    assert.equal(planningIfc.entityIndex.byId.has(f.plan.created[1].expressId), false, 'planning excludes superseded UV payload');
    const sdk = createExportAdapter(useViewerStore).ifc([{ modelId: MODEL, expressId: 25 }], {});
    assert.ok(sdk instanceof Uint8Array);
    const sdkArchive = await unwrapIfcZipWithResources(new Uint8Array(sdk).buffer);
    assert.equal(sdkArchive.originalResources.size, 1, 'SDK subset packages only surviving authored assets');
    assert.deepEqual(f.snapshot(), before, 'serialization cannot mutate live IFC, allocator or history');
    assert.equal(modelAppearanceAssets.exportResources(MODEL).resources.size, 2, 'both live history leases remain');
    useViewerStore.getState().undo(MODEL);
    assert.ok(f.view.getNewEntity(f.plan.created[0].expressId), 'original image is available to Undo');
    useViewerStore.getState().redo(MODEL);
    assert.deepEqual(f.snapshot().exported, before.exported);
  });
  it('serialization failure preserves live IFC and rejects a different model view (#4243)', async () => {
    const f = await fixture(); await f.commit(); await applyNext(f, 2);
    const before = f.snapshot();
    const data = useViewerStore.getState().models.get(MODEL)!.ifcDataStore!;
    assert.throws(() => prepareAppearanceSerialization(MODEL, data, new MutablePropertyView(data.properties, MODEL)), /different model revision/);
    mock.method(modelAppearanceAssets, 'exportResources', () => { throw new Error('Missing encoded image'); });
    assert.throws(() => prepareAppearanceSerialization(MODEL, data, f.view), /Missing encoded image/);
    assert.deepEqual(f.snapshot(), before);
    assert.ok(appearanceAssets.get(f.asset.id));
  });
  it('rejects a stale SDK positional edit after preview without overwriting it (#4243)', async () => {
    const f = await fixture();
    createStoreAdapter(useViewerStore).setPositionalAttribute({ modelId: MODEL, expressId: 19 }, 1, ['#14']);
    const changed = f.snapshot();
    assert.equal(changed.version, 0, 'SDK edit bypasses the viewer version');
    await assert.rejects(() => f.commit(), /overlay changed/);
    f.assertUncommitted(changed);
  });
  it('rejects skip-history edits after preview even without allocator or viewer revision changes (#4243)', async () => {
    const f = await fixture();
    f.view.setPositionalAttribute(10, 0, [[0, 0, 0], [2, 0, 0], [1, 1, 0], [0, 1, 0]], true);
    const changed = f.snapshot();
    await assert.rejects(() => f.commit(), /overlay changed/);
    f.assertUncommitted(changed);
  });
  it('refuses stale Undo for SDK changes to authored appearance or source geometry dependencies (#4243)', async () => {
    for (const geometry of [false, true]) {
      const f = await fixture(); await f.commit();
      const sdk = createStoreAdapter(useViewerStore);
      sdk.setPositionalAttribute({ modelId: MODEL, expressId: geometry ? 10 : f.plan.nextExpressId }, geometry ? 0 : 5,
        geometry ? [[0, 0, 0], [2, 0, 0], [1, 1, 0], [0, 1, 0]] : 'sdk-changed.png');
      const changed = f.snapshot(), parts = f.parts();
      assert.throws(() => useViewerStore.getState().undo(MODEL), /IFC geometry or appearance changed/);
      assert.deepEqual(f.snapshot(), changed); assert.strictEqual(f.parts(), parts);
      useViewerStore.getState().clearAllMutations(); modelAppearanceAssets.clear(); appearanceAssets.clear();
    }
  });
  it('rejects stale Redo after an SDK geometry edit while retaining the undone state (#4243)', async () => {
    const f = await fixture(); await f.commit();
    useViewerStore.getState().undo(MODEL);
    createStoreAdapter(useViewerStore).setPositionalAttribute({ modelId: MODEL, expressId: 10 }, 0,
      [[0, 0, 0], [2, 0, 0], [1, 1, 0], [0, 1, 0]]);
    const changed = f.snapshot(), parts = f.parts();
    assert.throws(() => useViewerStore.getState().redo(MODEL), /IFC geometry or appearance changed/);
    assert.deepEqual(f.snapshot(), changed); assert.strictEqual(f.parts(), parts);
  });
  it('rejects a replacement view even when visible revision and allocation match (#4243)', async () => {
    const f = await fixture();
    const model = useViewerStore.getState().models.get(MODEL)!;
    const replacement = new MutablePropertyView(model.ifcDataStore!.properties, MODEL);
    new StoreEditor(model.ifcDataStore!, replacement);
    useViewerStore.setState({ mutationViews: new Map([[MODEL, replacement]]) });
    const changed = f.snapshot();
    assert.equal(appearanceRevision(MODEL), f.plan.sourceRevision);
    assert.equal(replacement.peekNextExpressId(), f.plan.nextExpressId);
    await assert.rejects(() => f.commit(), /model was replaced/);
    f.assertUncommitted(changed);
    assert.equal(replacement.getNewEntities().length, 0);
  });
  it('keeps ordinary positional edit/Undo followed by appearance Undo/Redo working (#4243)', async () => {
    const f = await fixture(); await f.commit();
    useViewerStore.getState().setPositionalAttribute(MODEL, 19, 1, ['#15']);
    useViewerStore.getState().undo(MODEL);
    useViewerStore.getState().undo(MODEL);
    assert.equal(f.view.getNewEntity(f.plan.nextExpressId), null);
    useViewerStore.getState().redo(MODEL);
    assert.ok(f.view.getNewEntity(f.plan.nextExpressId));
  });
  it('collects superseded authored IFC images after history trimming without breaking Undo or later Apply', async () => {
    const f = await fixture(); await f.commit();
    const b = await applyNext(f, 2);
    appearanceAssets.releaseOwner(owner);
    const stack = useViewerStore.getState().undoStacks.get(MODEL)!;
    useViewerStore.setState({ undoStacks: new Map([[MODEL, stack.slice(1)]]) });
    await Promise.resolve();
    assert.ok(appearanceAssets.get(f.asset.id), 'B Undo still needs A after A history is trimmed');
    useViewerStore.getState().undo(MODEL);
    assert.match(new TextDecoder().decode(f.snapshot().exported), new RegExp(f.asset.exportName));
    useViewerStore.getState().redo(MODEL);
    const revision = useViewerStore.getState().mutationVersion;
    useViewerStore.setState({ undoStacks: new Map(), redoStacks: new Map() });
    await Promise.resolve();
    assert.equal(appearanceAssets.get(f.asset.id), undefined, 'orphan A has no remaining model/history owner');
    assert.ok(appearanceAssets.get(b.asset.id), 'live B survives clearing history');
    assert.doesNotMatch(new TextDecoder().decode(f.snapshot().exported), new RegExp(f.asset.exportName));
    assert.match(new TextDecoder().decode(f.snapshot().exported), new RegExp(b.asset.exportName));
    assert.equal(modelAppearanceAssets.exportResources(MODEL).resources.size, 1);
    assert.ok(useViewerStore.getState().mutationVersion > revision, 'IFC pruning invalidates stale preview revisions');
    assert.equal(useViewerStore.getState().undoStacks.size, 0, 'cleanup adds no visible Undo action');
    const c = await applyNext(f, 3);
    appearanceAssets.releaseOwner(owner);
    await Promise.resolve();
    assert.ok(appearanceAssets.get(b.asset.id), 'C Undo keeps B after B history was cleared');
    useViewerStore.setState({ undoStacks: new Map(), redoStacks: new Map() });
    await Promise.resolve();
    assert.equal(appearanceAssets.get(b.asset.id), undefined);
    assert.ok(appearanceAssets.get(c.asset.id));
    assert.doesNotMatch(new TextDecoder().decode(f.snapshot().exported), new RegExp(b.asset.exportName));
    modelAppearanceAssets.remove(MODEL);
    assert.equal(appearanceAssets.get(c.asset.id), undefined);
  });

  it('keeps an independently copied image URI after deleting its original ID, then releases after its final reference disappears', async () => {
    const f = await fixture(); await f.commit();
    const copy = f.editor.addEntity('IfcImageTexture', [true, true, 'DIFFUSE', null, null, f.asset.exportName]);
    f.editor.setPositionalAttribute(f.plan.created[3].expressId, 0, [`#${copy.expressId}`]);
    f.editor.setPositionalAttribute(f.plan.created[2].expressId, 0, [`#${copy.expressId}`]);
    f.editor.removeEntity(f.plan.created[0].expressId);
    appearanceAssets.releaseOwner(owner);
    useViewerStore.setState({ undoStacks: new Map(), redoStacks: new Map() });
    await Promise.resolve();
    assert.equal(f.view.getNewEntity(f.plan.created[0].expressId), null);
    assert.ok(appearanceAssets.get(f.asset.id));
    assert.equal(modelAppearanceAssets.exportResources(MODEL).resources.size, 1);
    const exported = await new IfcParser().parseColumnar(new Uint8Array(f.snapshot().exported).buffer);
    const image = new EntityExtractor(exported.source).extractEntity(exported.entityIndex.byId.get(copy.expressId)!);
    assert.equal(image?.attributes[5], f.asset.exportName, 'the actual exported IFC still needs these bytes');
    f.editor.setPositionalAttribute(19, 1, ['#15']);
    f.editor.removeEntity(f.plan.created[2].expressId);
    f.editor.removeEntity(copy.expressId);
    useViewerStore.getState().bumpMutationVersion();
    await Promise.resolve();
    assert.equal(appearanceAssets.get(f.asset.id), undefined, 'later SDK edits trigger URI reconciliation');
    assert.equal(modelAppearanceAssets.exportResources(MODEL).resources.size, 0);
  });

  it('Undo and a failed Redo preserve a live registration needed by another image URI', async () => {
    const f = await fixture(); await f.commit();
    const copy = f.editor.addEntity('IfcImageTexture', [true, true, 'DIFFUSE', null, null, f.asset.exportName]);
    appearanceAssets.releaseOwner(owner);
    useViewerStore.getState().undo(MODEL);
    assert.equal(modelAppearanceAssets.exportResources(MODEL).resources.size, 1);
    const before = f.snapshot();
    f.failStage(true);
    assert.throws(() => useViewerStore.getState().redo(MODEL), /GPU allocation refused/);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(modelAppearanceAssets.exportResources(MODEL).resources.size, 1);
    useViewerStore.setState({ undoStacks: new Map(), redoStacks: new Map() });
    await Promise.resolve();
    assert.ok(appearanceAssets.get(f.asset.id));
    f.editor.removeEntity(copy.expressId);
    useViewerStore.getState().bumpMutationVersion();
    await Promise.resolve();
    assert.equal(appearanceAssets.get(f.asset.id), undefined);
  });

  it('retains canonical IFC and image bytes when cleanup fails after editing its detached draft', async () => {
    const f = await fixture(); await f.commit(); const b = await applyNext(f, 4);
    appearanceAssets.releaseOwner(owner);
    await Promise.resolve();
    const before = f.snapshot().exported;
    const prepare = f.view.prepareAtomic.bind(f.view);
    const fault = mock.method(f.view, 'prepareAtomic', (edit: Parameters<typeof f.view.prepareAtomic>[0]) =>
      prepare(draft => { edit(draft); throw new Error('cleanup draft failed'); }));
    const warning = mock.method(console, 'warn', () => {});
    useViewerStore.setState({ undoStacks: new Map(), redoStacks: new Map() });
    await Promise.resolve();
    assert.deepEqual(f.snapshot().exported, before, 'failed draft cleanup publishes no partial IFC deletion');
    assert.ok(appearanceAssets.get(f.asset.id)); assert.ok(appearanceAssets.get(b.asset.id));
    assert.equal(modelAppearanceAssets.exportResources(MODEL).resources.size, 2);
    assert.match(String(warning.mock.calls[0]?.arguments[1]), /cleanup draft failed/);
    fault.mock.restore(); warning.mock.restore();
  });

  it('repeating an old prepared completion cannot orphan a newer GPU preview', async () => {
    const f = await fixture();
    const commit = f.preview.prepareCommit(f.groups);
    const changes = commit();
    f.preview.stage([{ ...f.groups[0], parts: [{ ...f.after, color: [0, 1, 0, 1] }] }]);
    assert.strictEqual(commit(), changes);
    f.preview.cancel();
    assert.deepEqual(f.parts()[0].color, f.after.color);
  });

  it('preserves triangle totals and updates vertex totals for welded/expanded undo and redo', async () => {
    const f = await fixture(MODEL, true);
    await f.commit();
    assert.equal(useViewerStore.getState().geometryResult?.totalTriangles, 2);
    assert.equal(useViewerStore.getState().geometryResult?.totalVertices, 6);
    useViewerStore.getState().undo(MODEL);
    assert.equal(useViewerStore.getState().geometryResult?.totalTriangles, 2);
    assert.equal(useViewerStore.getState().geometryResult?.totalVertices, 4);
    assert.equal(Object.isFrozen(useViewerStore.getState().geometryResult?.meshes[0]), false);
    assert.deepEqual(f.parts()[0].indices, f.before.indices);
    useViewerStore.getState().redo(MODEL);
    assert.equal(useViewerStore.getState().geometryResult?.totalVertices, 6);
    assert.deepEqual(f.parts()[0].indices, f.after.indices);
  });
  it('publishes and replays a primary object with omitted modelIndex (#4243 browser Undo regression)', async () => {
    const f = await fixture();
    const observations: number[] = [];
    const unsubscribe = useViewerStore.subscribe(state => {
      if (!state.undoStacks.get(MODEL)?.length) return;
      assert.equal(state.models.get(MODEL)?.geometryResult?.meshes[0].texture?.rgba[2], 255);
      assert.equal(f.editor.getNewEntity(f.plan.nextExpressId)?.type, 'IfcImageTexture');
      observations.push(state.mutationVersion);
    });
    await f.commit();
    unsubscribe();
    assert.equal(observations.length, 1);
    assert.equal(useViewerStore.getState().undoStacks.get(MODEL)?.length, 1);
    assert.equal(modelAppearanceAssets.exportResources(MODEL).resources.size, 1);
    useViewerStore.getState().undo(MODEL);
    assert.equal(f.editor.getNewEntity(f.plan.nextExpressId), null);
    assert.equal(f.parts()[0].texture?.rgba[0], 255);
    assert.equal(useViewerStore.getState().geometryResult?.meshes[0].texture?.rgba[0], 255);
    assert.equal(modelAppearanceAssets.exportResources(MODEL).resources.size, 0);
    useViewerStore.getState().redo(MODEL);
    assert.equal(f.editor.getNewEntity(f.plan.nextExpressId)?.type, 'IfcImageTexture');
    assert.equal(f.parts()[0].texture?.rgba[2], 255);
    assert.equal(modelAppearanceAssets.exportResources(MODEL).resources.size, 1);
  });

  it('cancels cooperative preparation without IFC, history, GPU or asset publication (#4336)', async () => {
    const f = await fixture(), initial = f.snapshot();
    const controller = new AbortController();
    let yields = 0;
    await assert.rejects(f.commit({ signal: controller.signal, maxSliceMs: Number.MIN_VALUE,
      yieldTask: async () => { yields++; controller.abort(); } }), { name: 'AbortError' });
    assert.ok(yields > 0, 'cancellation happens during actual detached preparation');
    f.assertUncommitted(initial);
  });

  it('rejects SDK edits made during cooperative preparation without reverting them (#4336)', async () => {
    const f = await fixture();
    let changed: ReturnType<typeof f.snapshot> | undefined;
    await assert.rejects(f.commit({ maxSliceMs: Number.MIN_VALUE, yieldTask: async () => {
      if (changed) return;
      f.view.setPositionalAttribute(19, 1, ['#14'], true);
      changed = f.snapshot();
    } }), /overlay changed/);
    assert.ok(changed);
    f.assertUncommitted(changed);
  });

  it('cancellation from final progress runs before any live publication (#4336)', async () => {
    const f = await fixture(), initial = f.snapshot();
    const controller = new AbortController();
    const phases: string[] = [];
    await assert.rejects(f.commit({ signal: controller.signal, onProgress: phase => {
      phases.push(phase);
      assert.deepEqual(f.snapshot(), initial);
      if (phase === 'publishing') controller.abort();
    } }), { name: 'AbortError' });
    assert.deepEqual(phases, ['preparing', 'validating', 'publishing']);
    f.assertUncommitted(initial);
  });

  it('rolls back allocator, IFC history, GPU and every image lease when GPU consumption fails', async () => {
    const f = await fixture(), initial = f.snapshot();
    f.failConsume(true);
    await assert.rejects(f.commit, /GPU token invalidated/);
    f.assertUncommitted(initial);
  });

  it('releases history and model leases if image registration fails after retaining the image', async () => {
    const f = await fixture(), initial = f.snapshot();
    const register = modelAppearanceAssets.registerAuthored.bind(modelAppearanceAssets);
    mock.method(modelAppearanceAssets, 'registerAuthored', (...args: Parameters<typeof register>) => {
      register(...args);
      throw new Error('Asset registration refused');
    });
    await assert.rejects(f.commit, /Asset registration refused/);
    f.assertUncommitted(initial);
  });

  it('does not commit IFC when its preview was already cancelled', async () => {
    const f = await fixture(), initial = f.snapshot();
    f.preview.cancel();
    await assert.rejects(f.commit, /preview is no longer active/);
    f.assertUncommitted(initial);
  });

  it('does not publish detached IFC edits when history preflight rejects a foreign model view', async () => {
    const f = await fixture('foreign-model'), initial = f.snapshot();
    await assert.rejects(f.commit, /applied mutations for the current model/);
    f.assertUncommitted(initial);
  });

  it('does not resurrect a model removed reentrantly during resource preparation', async () => {
    const f = await fixture(), initial = f.snapshot();
    const register = modelAppearanceAssets.registerAuthored.bind(modelAppearanceAssets);
    mock.method(modelAppearanceAssets, 'registerAuthored', (...args: Parameters<typeof register>) => {
      register(...args);
      useViewerStore.setState({ models: new Map(), geometryResult: null });
    });
    await assert.rejects(f.commit, /model changed/);
    assert.deepEqual(f.snapshot(), initial);
    assert.equal(useViewerStore.getState().models.has(MODEL), false);
    assert.equal(useViewerStore.getState().geometryResult, null);
    assert.equal(modelAppearanceAssets.exportResources(MODEL).resources.size, 0);
    appearanceAssets.releaseOwner(owner);
    assert.equal(appearanceAssets.get(f.asset.id), undefined);
  });

  it('failed undo and redo leave the current IFC/GPU/export resources and both stacks unchanged', async () => {
    const f = await fixture();
    await f.commit();
    for (const direction of ['undo', 'redo'] as const) {
      const initial = f.snapshot(), parts = f.parts(), geometry = useViewerStore.getState().geometryResult;
      const resources = modelAppearanceAssets.exportResources(MODEL).resources;
      f.failStage(true);
      assert.throws(() => useViewerStore.getState()[direction](MODEL), /GPU allocation refused/);
      assert.deepEqual(f.snapshot(), initial);
      assert.deepEqual(f.parts(), parts);
      assert.strictEqual(useViewerStore.getState().geometryResult, geometry);
      assert.deepEqual(modelAppearanceAssets.exportResources(MODEL).resources, resources);
      f.failStage(false);
      f.failConsume(true);
      assert.throws(() => useViewerStore.getState()[direction](MODEL), /GPU token invalidated/);
      assert.deepEqual(f.snapshot(), initial);
      assert.deepEqual(f.parts(), parts);
      assert.deepEqual(modelAppearanceAssets.exportResources(MODEL).resources, resources);
      f.failConsume(false);
      useViewerStore.getState()[direction](MODEL);
    }
  });
});
