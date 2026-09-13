/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { AppearanceAssetInventory } from './assets.js';
import { ModelAppearanceAssets, modelAppearanceAssets } from './model-assets.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
const png = () => new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
function image() { return { width: 1, height: 1, closes: 0, close() { this.closes++; } }; }
const archive = () => ({ originalResources: new Map([['nested/Textures/Wood.PNG', png()]]), modelPath: 'nested/model.ifc' });

// #4243: loaded geometry and portable exports have separate lifetimes.
it('keeps original paths/encoded bytes through import, model replacement and federation close', async () => {
  const bitmap = image();
  const inventory = new AppearanceAssetInventory({ decode: async () => bitmap });
  const models = new ModelAppearanceAssets(inventory);
  for (const model of ['a', 'b', 'a']) {
    const load = models.begin(model);
    assert.equal((await load.decode(archive()))?.get('wood.png'), bitmap);
    load.finish(true);
  }
  models.remove('a');
  assert.equal(bitmap.closes, 0);
  const exported = models.exportOriginals('b');
  assert.equal(exported.modelPath, 'nested/model.ifc');
  assert.deepEqual(exported.resources.get('nested/Textures/Wood.PNG'), png());
  models.clear();
  assert.equal(bitmap.closes, 1);
  assert.equal(models.exportOriginals('b').resources.size, 0);
});

it('failed load releases decoded images without publishing original resources', async () => {
  const bitmap = image();
  const models = new ModelAppearanceAssets(new AppearanceAssetInventory({ decode: async () => bitmap }));
  const load = models.begin('failed');
  assert.throws(() => models.exportOriginals('failed'), /still loading/);
  await load.decode(archive());
  load.finish(false);
  assert.equal(bitmap.closes, 1);
  assert.equal(models.exportOriginals('failed').resources.size, 0);
});

it('model close during decode closes the late bitmap and prevents stale load publication', async () => {
  let resolve!: (value: ReturnType<typeof image>) => void;
  let started!: () => void;
  const begun = new Promise<void>(yes => { started = yes; });
  const bitmap = image();
  const models = new ModelAppearanceAssets(new AppearanceAssetInventory({ decode: () => {
    started();
    return new Promise<ReturnType<typeof image>>(yes => { resolve = yes; });
  } }));
  const load = models.begin('closing');
  const loading = load.decode(archive());
  await begun;
  models.remove('closing');
  await assert.rejects(loading, { name: 'AbortError' });
  resolve(bitmap);
  await new Promise<void>(yes => setImmediate(yes));
  load.finish(true);
  assert.equal(bitmap.closes, 1);
  assert.equal(models.exportOriginals('closing').resources.size, 0);
});

it('preserves distinct same-basename originals while existing viewer resolution stays first-wins', async () => {
  const second = png(); second[second.length - 1] ^= 1;
  const models = new ModelAppearanceAssets(new AppearanceAssetInventory({ decode: async () => image() }));
  const load = models.begin('collisions');
  const bitmaps = await load.decode({ originalResources: new Map([['a/wood.png', png()], ['b/wood.png', second]]) });
  load.finish(true);
  assert.equal(bitmaps?.size, 1);
  const exported = models.exportOriginals('collisions');
  assert.deepEqual(exported.resources.get('a/wood.png'), png());
  assert.deepEqual(exported.resources.get('b/wood.png'), second);
  models.clear();
});

// Exercise real teardown actions: a reset preserves models; close releases them.
it('real model teardown keeps textures through view reset and releases on close/clear', async () => {
  const previous = globalThis.createImageBitmap;
  const bitmaps: ReturnType<typeof image>[] = [];
  globalThis.createImageBitmap = async () => { const bitmap = image(); bitmaps.push(bitmap); return bitmap; };
  try {
    useViewerStore.setState(fixtureModels(fixtureModel('a'), fixtureModel('b')));
    for (const id of ['a', 'b']) {
      const load = modelAppearanceAssets.begin(id);
      await load.decode(archive());
      load.finish(true);
    }
    useViewerStore.getState().resetViewerState();
    assert.equal(bitmaps[0].closes, 0);
    assert.equal(modelAppearanceAssets.exportOriginals('a').resources.size, 1);
    useViewerStore.getState().removeModel('a');
    assert.equal(bitmaps[0].closes, 0);
    assert.equal(modelAppearanceAssets.exportOriginals('a').resources.size, 0);
    useViewerStore.getState().clearAllModels();
    assert.equal(bitmaps[0].closes, 1);
  } finally {
    modelAppearanceAssets.clear();
    globalThis.createImageBitmap = previous;
  }
});

it('refuses incomplete portable export when an original image was rejected', async t => {
  const warning = t.mock.method(console, 'warn', () => {});
  const models = new ModelAppearanceAssets(new AppearanceAssetInventory({ decode: async () => image() }));
  const load = models.begin('invalid');
  const bitmaps = await load.decode({ originalResources: new Map([
    ['a/wood.png', new Uint8Array([1, 2, 3])], ['b/wood.png', png()],
  ]) });
  load.finish(true);
  // Preserve historical basename first-wins even when the first entry is invalid.
  assert.equal(bitmaps, null);
  assert.equal(warning.mock.callCount(), 1);
  assert.throws(() => models.exportOriginals('invalid'), /a\/wood.png/);
  models.clear();
});

it('does not claim a complete portable export when the parser omitted archive images', async () => {
  const models = new ModelAppearanceAssets(new AppearanceAssetInventory({ decode: async () => image() }));
  const load = models.begin('partial');
  await load.decode({ ...archive(), resourcesIncomplete: true });
  load.finish(true);
  assert.throws(() => models.exportOriginals('partial'), /exceeded image extraction limits/);
  models.clear();
});

it('registers authored uses only on Apply, preserves shared commands through undo and restores on redo', async () => {
  const bitmap = image();
  const inventory = new AppearanceAssetInventory({ decode: async () => bitmap });
  const models = new ModelAppearanceAssets(inventory);
  const owner = { kind: 'history' as const, id: 'history' };
  const asset = await inventory.add(png(), { owner });
  const uri = models.getAuthoredUri('model', asset.id);
  assert.equal(models.hasResources('model'), false);
  assert.equal(models.exportResources('model').resources.size, 0);
  models.registerAuthored('model', 'first', [asset.id]);
  models.registerAuthored('model', 'second', [asset.id]);
  models.unregisterAuthored('model', 'first');
  assert.equal(models.hasResources('model'), true);
  assert.deepEqual(models.exportResources('model').resources.get(uri), png());
  models.unregisterAuthored('model', 'second');
  assert.equal(models.hasResources('model'), false);
  assert.equal(models.exportResources('model').resources.size, 0);
  assert.ok(inventory.get(asset.id), 'history retains bytes for redo');
  models.registerAuthored('model', 'first', [asset.id]);
  inventory.releaseOwner(owner);
  assert.deepEqual(models.exportResources('model').resources.get(uri), png());
  models.clear();
  assert.equal(inventory.get(asset.id), undefined);
});

it('rejects a forged imported digest basename and validates a whole registration before retaining', async () => {
  const inventory = new AppearanceAssetInventory({ decode: async () => image() });
  const models = new ModelAppearanceAssets(inventory);
  const owner = { kind: 'source' as const, id: 'upload' };
  const asset = await inventory.add(png(), { owner });
  const other = png(); other[other.length - 1] ^= 1;
  const load = models.begin('model');
  await load.decode({ originalResources: new Map([[`another/${asset.exportName.split('/').pop()}`, other]]) });
  load.finish(true);
  assert.throws(() => models.getAuthoredUri('model', asset.id), /different content/);
  assert.throws(() => models.registerAuthored('new-model', 'cmd', [asset.id, 'missing']), /released/);
  inventory.releaseOwner(owner);
  assert.equal(inventory.get(asset.id), undefined, 'failed registration did not retain the valid first asset');
  models.clear();
});

// Allocation-footprint fixture: Convento's six 4096² JPEG images, without
// allocating 384 MiB of pixel buffers in a unit test. Header dimensions match
// the injected decoder's tracked bitmap footprint; real decoding is the viewer lab gate.
it('retains all six Convento-sized JPEGs plus a new authoring source under default budgets', async () => {
  const original = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDx/9k=', 'base64'));
  const frame = original.findIndex((value, index) => value === 0xff && original[index + 1] === 0xc0);
  const resources = new Map<string, Uint8Array>();
  for (let i = 0; i < 6; i++) {
    const bytes = new Uint8Array(original);
    const header = new DataView(bytes.buffer);
    header.setUint16(frame + 5, 4096); header.setUint16(frame + 7, 4096);
    bytes[bytes.length - 3] = i; // Distinct encoded identities, one bitmap each.
    resources.set(`texture${i}.jpg`, bytes);
  }
  const decoded: Array<{ width: number; height: number; closes: number; close(): void }> = [];
  const inventory = new AppearanceAssetInventory({ decode: async bytes => {
    const large = bytes[0] === 0xff;
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bitmap = { width: large ? 4096 : header.getUint32(16), height: large ? 4096 : header.getUint32(20), closes: 0, close() { this.closes++; } };
    decoded.push(bitmap); return bitmap;
  } });
  const models = new ModelAppearanceAssets(inventory);
  const load = models.begin('convento');
  assert.equal((await load.decode({ originalResources: resources }))?.size, 6);
  load.finish(true);
  const owner = { kind: 'draft' as const, id: 'new-image' };
  const uploaded = png();
  const header = new DataView(uploaded.buffer); header.setUint32(16, 1024); header.setUint32(20, 1024);
  const asset = await inventory.add(uploaded, { owner });
  await inventory.decode(asset.id, owner);
  assert.equal(decoded.length, 7);
  assert.equal(decoded[6].width, 1024);
  assert.equal(models.exportResources('convento').resources.size, 6);
  inventory.releaseOwner(owner); models.clear();
  assert.ok(decoded.every(bitmap => bitmap.closes === 1));
});

it('surfaces archive decode budget failures instead of publishing partially textured geometry', async () => {
  const other = png(); other[other.length - 1] ^= 1;
  const bitmap = image();
  const inventory = new AppearanceAssetInventory({ decode: async () => bitmap, limits: { maxDecodedBytes: 4 } });
  const models = new ModelAppearanceAssets(inventory);
  const load = models.begin('over-budget');
  await assert.rejects(load.decode({ originalResources: new Map([['one.png', png()], ['two.png', other]]) }), /Decoded image budget exceeded/);
  load.finish(false);
  assert.equal(bitmap.closes, 1);
  assert.equal(models.exportResources('over-budget').resources.size, 0);
});

// #4243 independent review: source ownership must not depend on flat geometry.
it('keeps metadata-only and instanced-only IFC originals, but releases failed placeholders', async () => {
  const bitmap = image();
  const models = new ModelAppearanceAssets(new AppearanceAssetInventory({ decode: async () => bitmap }));
  const metadata = { ...fixtureModel('metadata'), geometryResult: null };
  const point = { x: 0, y: 0, z: 0 };
  const bounds = { min: point, max: point };
  const instanced = { ...fixtureModel('instanced'), geometryResult: {
    meshes: [], totalVertices: 3, totalTriangles: 1, instancedGeometryHashes: new Map([[1, 1n]]),
    coordinateInfo: { originShift: point, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false },
  } };
  const failed = { ...fixtureModel('failed'), ifcDataStore: null, geometryResult: null };
  useViewerStore.setState(fixtureModels(metadata, instanced, failed));
  // Global geometry belongs to another active model; finalization must resolve its own.
  useViewerStore.setState({ activeModelId: 'failed', geometryResult: null });
  for (const id of ['metadata', 'instanced', 'failed', 'removed']) {
    const load = models.begin(id);
    await load.decode(archive());
    load.finishForModel(useViewerStore.getState().models.get(id));
    assert.equal(models.hasResources(id), id === 'metadata' || id === 'instanced');
    assert.equal(models.exportOriginals(id).resources.size, id === 'metadata' || id === 'instanced' ? 1 : 0);
  }
  models.clear();
  assert.equal(bitmap.closes, 1, 'failed placeholders and removed models must not leak a pending source owner');
  useViewerStore.getState().clearAllModels();
});

// #4261: geometry completes before primary metadata, which finalizes in background.
it('holds images until delayed metadata finalization and releases rejected or removed loads', async () => {
  for (const outcome of ['success', 'partial', 'reject', 'remove'] as const) {
    const bitmap = image();
    const models = new ModelAppearanceAssets(new AppearanceAssetInventory({ decode: async () => bitmap }));
    const load = models.begin(outcome);
    await load.decode(archive());
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const finalization = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    let model = { ...fixtureModel(outcome), ifcDataStore: null as ReturnType<typeof fixtureModel>['ifcDataStore'] };
    const settled = load.finishAfter(finalization, () => model);
    assert.equal(load.finishAfter(Promise.resolve(), () => model), settled, 'completion registration is once-only');
    load.finishForModel(model); // The canonical loader's early finally.
    assert.equal(bitmap.closes, 0, 'geometry completion cannot close an image still used by the viewport');
    assert.throws(() => models.exportOriginals(outcome), /still loading/);
    if (outcome === 'remove') { models.remove(outcome); assert.equal(bitmap.closes, 1); }
    if (outcome !== 'reject') model = fixtureModel(outcome);
    if (outcome === 'reject' || outcome === 'partial') reject(new Error('metadata failed')); else resolve();
    await settled;
    assert.equal(models.exportOriginals(outcome).resources.size, outcome === 'success' || outcome === 'partial' ? 1 : 0);
    models.clear();
    assert.equal(bitmap.closes, 1);
  }
});

// #4243: collected authored definitions must not release an imported owner's bytes.
it('reconciles authored definitions while preserving shared originals and cancelling removal-time cleanup', async () => {
  for (const removedBeforeCleanup of [false, true]) {
    const bitmap = image();
    const inventory = new AppearanceAssetInventory({ decode: async () => bitmap });
    const models = new ModelAppearanceAssets(inventory);
    const load = models.begin('gc'); await load.decode(archive()); load.finish(true);
    const owner = { kind: 'draft' as const, id: 'gc' };
    const asset = await inventory.add(png(), { owner });
    const source = new TextEncoder().encode("ISO-10303-21;HEADER;FILE_DESCRIPTION(('GC'),'2;1');FILE_NAME('gc.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;#1=IFCCOLOURRGB($,1.,1.,1.);ENDSEC;END-ISO-10303-21;");
    const dataStore = await new IfcParser().parseColumnar(source.buffer);
    const view = new MutablePropertyView(dataStore.properties, 'gc');
    const editor = new StoreEditor(dataStore, view);
    const texture = editor.addEntity('IfcImageTexture', [true, true, 'DIFFUSE', null, null, asset.exportName]);
    models.registerAuthored('gc', 'command', [asset.id]);
    let revisions = 0;
    models.authoredLifecycle.track('gc', 'command', { dataStore, view, isCurrent: () => true, changed: () => { revisions++; } }, view.getNewEntities(), []);
    models.authoredLifecycle.retire('gc', 'command');
    inventory.releaseOwner(owner);
    if (removedBeforeCleanup) models.remove('gc');
    await Promise.resolve();
    if (removedBeforeCleanup) {
      assert.equal(revisions, 0);
      assert.ok(view.getNewEntity(texture.expressId), 'queued cleanup cannot mutate an unloaded model');
    } else {
      assert.equal(revisions, 1);
      assert.equal(view.getNewEntity(texture.expressId), null);
      assert.ok(inventory.get(asset.id));
      assert.deepEqual(models.exportResources('gc').resources, archive().originalResources);
      assert.equal(bitmap.closes, 0, 'shared imported source still owns its decoded bitmap');
    }
    models.clear();
    assert.equal(bitmap.closes, 1);
  }
});


it('filtered serialization preserves imported bytes and live authored leases (#4243)', async () => {
  const bitmap = image();
  const inventory = new AppearanceAssetInventory({ decode: async () => bitmap });
  const models = new ModelAppearanceAssets(inventory);
  const lease = models.begin('filtered'); await lease.decode(archive()); lease.finish(true);
  const owner = { kind: 'draft' as const, id: 'filtered-image' };
  const asset = await inventory.add(png(), { owner });
  models.registerAuthored('filtered', 'command', [asset.id]);
  inventory.releaseOwner(owner);
  const filtered = models.exportResources('filtered', new Set());
  assert.deepEqual([...filtered.resources.keys()], ['nested/Textures/Wood.PNG']);
  assert.deepEqual(filtered.resources.get('nested/Textures/Wood.PNG'), png());
  assert.equal(models.exportResources('filtered').resources.size, 2, 'filtering an archive cannot release its live authored registration');
  assert.equal(bitmap.closes, 0);
  models.remove('filtered');
  assert.equal(bitmap.closes, 1);
});

// #4380: creation must bind the retained original, never recover pixels from GPU.
it('resolves capture originals across URI spelling and rejects ambiguous or removed sources', async () => {
  const inventory = new AppearanceAssetInventory({ decode: async () => image() });
  const models = new ModelAppearanceAssets(inventory);
  const load = models.begin('capture');
  assert.throws(() => models.resolveImageAsset('capture', 'wood.png'), /still loading/);
  await load.decode(archive()); load.finish(true);
  const id = models.resolveImageAsset('capture', './Textures/Wood%2EPNG');
  assert.deepEqual(inventory.encoded(id), png());
  const distinct = png(); distinct[distinct.length - 1] ^= 1;
  const replacement = models.begin('capture');
  await replacement.decode({ originalResources: new Map([['a/wood.png', png()], ['b/wood.png', distinct]]) });
  replacement.finish(true);
  assert.throws(() => models.resolveImageAsset('capture', 'a/wood.png'), /different original images/);
  models.remove('capture');
  assert.throws(() => models.resolveImageAsset('capture', 'wood.png'), /missing/);
  assert.equal(inventory.get(id), undefined);
});

// #4477: the loader publishes a model before its images settle; a panel that
// saw "still loading" needs a moment to retry rather than staying stuck.
it('pendingDecode resolves when the source decode finishes or is cancelled, and is absent when idle', async () => {
  const inventory = new AppearanceAssetInventory({ decode: async () => image() });
  const models = new ModelAppearanceAssets(inventory);
  assert.equal(models.pendingDecode('idle'), undefined);
  const load = models.begin('capture');
  let settled = false;
  const waiting = models.pendingDecode('capture')!.then(() => { settled = true; });
  await load.decode(archive());
  assert.equal(settled, false, 'decoding alone does not settle the lease');
  load.finish(true);
  await waiting;
  assert.equal(models.pendingDecode('capture'), undefined);
  assert.doesNotThrow(() => models.resolveImageAsset('capture', 'wood.png'));
  const replaced = models.begin('capture');
  const cancelled = models.pendingDecode('capture')!;
  models.remove('capture');
  await cancelled;
  assert.equal(models.pendingDecode('capture'), undefined);
  replaced.finish(true);
});
