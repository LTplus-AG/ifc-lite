/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { IfcParser, EntityExtractor } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';

const source = new TextEncoder().encode(`ISO-10303-21;
HEADER;FILE_DESCRIPTION(('Catalog contract'),'2;1');FILE_NAME('catalog.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCWALL('wall',$,'Wall',$,$,$,$,$,.NOTDEFINED.);
#2=IFCSLAB('slab',$,'Slab',$,$,$,$,$,.FLOOR.);
#3=IFCWALL('other',$,'Other wall',$,$,$,$,$,.NOTDEFINED.);
#11=IFCCARTESIANPOINT((0.,0.,0.));
#20=IFCWALLTYPE('walltype',$,'Duplicate',$,$,$,$,$,$,.NOTDEFINED.);
#21=IFCSLABTYPE('slabtype',$,'Duplicate',$,$,$,$,$,$,.FLOOR.);
#30=IFCRELDEFINESBYTYPE('rel1',$,$,$,(#1,#3),#20);
#31=IFCRELDEFINESBYTYPE('rel2',$,$,$,(#2),#21);
ENDSEC;END-ISO-10303-21;`);

test('actual WASM catalog matches canonical exported overlay retypes and type membership (#4243)', async t => {
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  try { await access(wasmUrl); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Build WASM with pnpm build:wasm to run the actual catalog contract'); return;
  }
  const { default: init } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const { runAppearanceCatalog } = await import('../../workers/appearance.worker.js');
  const store = await new IfcParser().parseColumnar(source.buffer);
  const view = new MutablePropertyView(store.properties, 'catalog');
  const editor = new StoreEditor(store, view);
  editor.setEntityType(1, 'IfcSlab', { predefinedType: 'FLOOR' });
  const owner = editor.addEntity('IfcWall', ['created', null, 'Created wall', null, null, null, null, null, '.NOTDEFINED.']);
  const type = editor.addEntity('IfcWallType', ['created-type', null, 'Duplicate', null, null, null, null, null, null, '.NOTDEFINED.']);
  editor.setAttribute(30, 'RelatingType', '#21');
  editor.setPositionalAttribute(30, 5, `#${type.expressId}`); // Canonical positional override wins.
  editor.setPositionalAttribute(30, 4, ['#1', `#${owner.expressId}`]);
  editor.removeEntity(3);
  // Pinned FILE_NAME timestamp: `snapshot()` is byte-compared against an export taken earlier in the
  // same test, and two exports that straddle a wall-clock second differ by one header digit.
  const snapshot = () => new Uint8Array(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '20260101T000000' }).content);
  const bytes = snapshot(), mutations = structuredClone(view.getMutations()), next = view.peekNextExpressId();
  const request = { schema: 'IFC4' as const, sourceRevision: 'effective', productIds: [owner.expressId, 3, 11, 2, 1] };
  const catalog = await runAppearanceCatalog(bytes, request);
  assert.deepEqual(catalog.products, [
    { productId: 1, ifcClass: 'IfcSlab', typeIds: [type.expressId] },
    { productId: 2, ifcClass: 'IfcSlab', typeIds: [21] },
    { productId: owner.expressId, ifcClass: 'IfcWall', typeIds: [type.expressId] },
  ]);
  assert.deepEqual(catalog.missingProductIds, [3, 11]);
  assert.deepEqual(catalog.types.map(type => [type.typeId, type.Name]), [[21, 'Duplicate'], [type.expressId, 'Duplicate']]);
  const parsed = await new IfcParser().parseColumnar(bytes.buffer);
  const relationship = new EntityExtractor(parsed.source).extractEntity(parsed.entityIndex.byId.get(30)!);
  assert.equal(relationship?.attributes[5], type.expressId, 'catalog agrees with actual exported IFC');
  assert.equal(view.peekNextExpressId(), next);
  assert.deepEqual(view.getMutations(), mutations);
  assert.deepEqual(snapshot(), bytes, 'catalog does not change IFC or detach the caller source');
  await assert.rejects(runAppearanceCatalog(bytes, { ...request, productIds: new Array(10_001).fill(1) }), /owner\/revision budget/);
  editor.setPositionalAttribute(30, 5, '#21');
  const updated = await runAppearanceCatalog(snapshot(), { ...request, sourceRevision: 'changed' });
  assert.deepEqual(updated.products[0].typeIds, [21]);
  assert.equal(updated.sourceRevision, 'changed');
});


test('actual Convento catalog resolves the four scanned IFC wall owners (#4243)', async t => {
  const corpus = process.env.IFCLITE_APPEARANCE_CORPUS_IFC;
  if (!corpus) { t.skip('Set IFCLITE_APPEARANCE_CORPUS_IFC after pnpm fixtures for Convento'); return; }
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  try { await access(corpus); await access(wasmUrl); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Fetch the model with pnpm fixtures and build WASM with pnpm build:wasm'); return;
  }
  const { default: init } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const { runAppearanceCatalog } = await import('../../workers/appearance.worker.js');
  const catalog = await runAppearanceCatalog(new Uint8Array(await readFile(corpus)),
    { schema: 'IFC4', sourceRevision: 'convento-catalog', productIds: [833, 23, 667, 201] });
  assert.deepEqual(catalog.products.map(product => product.productId), [23, 201, 667, 833]);
  assert.ok(catalog.products.every(product => product.ifcClass === 'IfcWall'));
  assert.deepEqual(catalog.missingProductIds, []);
  for (const product of catalog.products) {
    assert.ok(product.typeIds.length > 0);
    for (const id of product.typeIds) assert.ok(catalog.types.some(type => type.typeId === id));
  }
});
