/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore, type ViewerState } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state.js';
import { AppearanceAssetInventory } from '../assets.js';
import type { RegisteredAppearanceReference } from '../references/types.js';
import type { ReferenceImageInput } from '@ifc-lite/renderer';
import { connectAppearanceReferences, type ReferenceRuntimeDiagnostic } from './connect.js';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64'));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function fixture() {
  let decode: (image: ImageBitmap) => void = () => { throw new Error('decode not started'); };
  let closed = 0;
  const bitmap = { width:1, height:1, close() { closed++; } } as ImageBitmap;
  const inventory = new AppearanceAssetInventory({ decode: () => new Promise<ImageBitmap>(resolve => { decode = resolve; }) });
  const owner = { kind:'source' as const, id:'fixture' }, asset = await inventory.add(png, { owner });
  const record: RegisteredAppearanceReference = { id:'registered', sourceId:'page', assetId:asset.id,
    cornersIfcWorld:[[0,0,1],[1,0,1],[1,0,0],[0,0,0]], frameKey:'local-engineering:m:z-up', visible:true, locked:false, opacity:1 };
  let state: ViewerState = { ...useViewerStore.getState(), models:new Map(), geometryResult:null,
    modelPlacement:emptyPlacementState(), appearanceReferences:new Map([[record.id,record]]) };
  const listeners = new Set<(state:ViewerState) => void>(), diagnostics:ReferenceRuntimeDiagnostic[] = [], uploads:ReferenceImageInput[] = [], removed:string[] = [];
  let uploadDone: () => void = () => { throw new Error('upload not started'); };
  const disconnect = connectAppearanceReferences({ getReferenceImages: () => ({
    set: image => { uploads.push(image); return new Promise<void>(resolve => { uploadDone = resolve; }); },
    remove: id => { removed.push(id); }, clear() { throw new Error('must not clear another controller’s drafts'); }, pick: async () => null,
  }), onDeviceLost: () => () => {} }, {
    getState: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  }, diagnostic => diagnostics.push(diagnostic), inventory);
  return { record, asset, inventory, owner, uploads, removed, diagnostics, disconnect,
    decode: () => decode(bitmap), uploadDone: () => uploadDone(), closed: () => closed,
    update: (records: ReadonlyMap<string,RegisteredAppearanceReference>) => { state = { ...state, appearanceReferences:records }; for (const fn of listeners) fn(state); },
  };
}

test('reference runtime retains decode through upload after source removal, then releases final bitmap (#4308)', async () => {
  const f = await fixture();
  f.inventory.release(f.asset.id, f.owner); f.decode(); await tick();
  assert.equal(f.uploads.length, 1); assert.equal(f.closed(), 0);
  assert.deepEqual(f.uploads[0].corners.map(point => point.map(n => n === 0 ? 0 : n)), [[0,1,0],[1,1,0],[1,0,0],[0,0,0]]);
  f.uploadDone(); await tick(); assert.equal(f.closed(), 1);
  assert.equal(f.diagnostics.at(-1)?.status, 'ready'); f.disconnect();
});

test('removed reference never uploads a late decoder and cannot clear transient draft IDs (#4308)', async () => {
  const f = await fixture(); f.update(new Map()); f.inventory.release(f.asset.id, f.owner);
  f.decode(); await tick();
  assert.equal(f.uploads.length, 0); assert.equal(f.closed(), 1);
  assert.ok(f.removed.every(id => id === 'registered')); f.disconnect();
});

test('frame mismatch and hidden references are explicit and remove their old GPU owner (#4308)', async () => {
  const f = await fixture(); f.decode(); await tick(); f.uploadDone(); await tick();
  f.update(new Map([['registered',{ ...f.record, frameKey:'other-engineering-frame' }]]));
  assert.equal(f.diagnostics.at(-1)?.status, 'frame-mismatch');
  f.update(new Map([['registered',{ ...f.record, visible:false }]]));
  assert.equal(f.diagnostics.at(-1)?.status, 'hidden');
  assert.equal(f.uploads.length, 1); f.disconnect(); f.inventory.release(f.asset.id, f.owner);
});
