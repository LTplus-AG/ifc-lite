/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { copyBatchInStore, copySourcesInStore } from './copy-batch.js';
import { createCopyContext } from './copy-product.js';
import { addHostedElementInStore } from './hosted-element.js';

for (const persisted of [false, true]) it(`#6232 actual carried-product work is bounded separately from pruned roots persisted=${persisted}`, async () => {
  const bytes = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  let store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  let view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  addHostedElementInStore(store, editor, 1222, { kind: 'opening', params: { Offset: 4, Width: .3, Height: .4 } });
  const text = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content);
  if (persisted) {
    store = await new IfcParser().parseColumnar(new TextEncoder().encode(text()).buffer, { disableWorkerScan: true });
    view = new MutablePropertyView(null, 'm'); editor = new StoreEditor(store, view);
  }
  const [copy] = copyBatchInStore(store, editor, [1222], [{ offset: [0, 3, 0] }]);
  // Actual public writer cardinality, including openings omitted from preview.
  expect(copy.copiedFrom.size).toBe(6);
  const ctx = createCopyContext(store, editor);
  expect(copySourcesInStore(ctx, [1222], 8333)).toEqual({ ids: [1222] });
  expect(copySourcesInStore(ctx, [1222], 8334)).toEqual({ refusal: 'Copy carried products exceed 50000 product writes' });
  const before = text(), records = structuredClone(editor.getNewEntities()), journal = structuredClone(view.getMutations()), next = view.peekNextExpressId();
  expect(() => copyBatchInStore(store, editor, [1222], Array.from({ length: 8334 }, () => ({ offset: [0, 3, 0] as [number, number, number] })))).toThrow(/carried products.*50000/);
  expect(text()).toBe(before); expect(editor.getNewEntities()).toEqual(records);
  expect(view.getMutations()).toEqual(journal); expect(view.peekNextExpressId()).toBe(next);
});
