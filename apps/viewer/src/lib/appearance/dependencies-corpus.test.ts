/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { EntityExtractor, getAttributeNamesAcrossSchemas, IfcParser } from '@ifc-lite/parser';
import { captureAppearanceDependencies, StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { applyAppearanceEntities } from './apply-plan.js';

test('real Convento dependency guard accepts before/after entire-model planar Apply and repeat Apply (#4243)', async t => {
  const corpus = process.env.IFCLITE_APPEARANCE_CORPUS_IFC;
  if (!corpus) { t.skip('Set IFCLITE_APPEARANCE_CORPUS_IFC after pnpm fixtures for the actual Convento contract'); return; }
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  try { await access(corpus); await access(wasmUrl); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Fetch the IFC with pnpm fixtures and build WASM with pnpm build:wasm'); return;
  }
  const { default: init } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const { runAppearancePlanning } = await import('../../workers/appearance.worker.js');
  let bytes = new Uint8Array(await readFile(corpus));
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(store.properties, 'convento');
  const editor = new StoreEditor(store, view), extractor = new EntityExtractor(store.source);
  const products: number[] = [];
  for (const [id, record] of store.entityIndex.byId) {
    const slot = getAttributeNamesAcrossSchemas(record.type).indexOf('Representation');
    if (slot >= 0 && extractor.extractEntity(record)?.attributes[slot]) products.push(id);
  }
  assert.equal(products.length, 20);
  const roots = new Set(products);
  captureAppearanceDependencies(store, view, roots).validate(view);
  for (let pass = 0; pass < 2; pass++) {
    const revision = `convento-${pass}`;
    const plan = await runAppearancePlanning(bytes, { schema: 'IFC4', sourceRevision: revision,
      nextExpressId: view.peekNextExpressId(), productIds: products, imageUri: `appearance-${pass}.png`,
      repeatS: true, repeatT: true,
      mapping: { kind: 'planar', frame: 'item', origin: [0, 0, 0], axisU: [1, 0, 0], axisV: [0, 1, 0], metresPerTile: [1, 1] } });
    assert.deepEqual(plan.exclusions, []);
    assert.equal(new Set(plan.items.map(item => item.productId)).size, 20);
    const prepared = view.prepareAtomic(draft => {
      applyAppearanceEntities(new StoreEditor(store, draft), draft, plan, revision);
      return captureAppearanceDependencies(store, draft, roots);
    });
    prepared.commit(); prepared.result.validate(view);
    const exported = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    bytes = new Uint8Array(exported);
    t.diagnostic(`pass ${pass + 1}: ${plan.items.length} items; effective IFC ${bytes.byteLength} bytes`);
  }
  assert.ok(editor.getNewEntities().some(entity => entity.type === 'IfcImageTexture'));
});
