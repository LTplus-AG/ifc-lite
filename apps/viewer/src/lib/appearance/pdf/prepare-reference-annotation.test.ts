/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { useViewerStore } from '@/store';
import { pdfReferenceAnnotationFixture } from '@/test/pdf-reference-annotation-fixture';
import { createAppearancePlanner, type AppearanceWorker } from '../planner-worker-client';
import type { PdfFillAnnotationPlan } from './fill-plan-types';
import { preparePdfReferenceAnnotation } from './prepare-reference-annotation';

test('original PDF and exact effective IFC bind the native multicolour preview before any authoring (#4406)', async t => {
  let binary: Buffer;
  try { binary = await readFile(new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; t.skip('Build WASM with pnpm build:wasm'); return; }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm'); await init({ module_or_path: binary });
  const api = new IfcAPI(), fixture = await pdfReferenceAnnotationFixture();
  let foreign = false;
  const planner = createAppearancePlanner({ workerFactory() {
    const worker: AppearanceWorker = { onmessage: null, onerror: null, onmessageerror: null, terminate() {}, postMessage(message) {
      if (message.type !== 'pdf-fill-plan') throw new Error('Unexpected planner operation');
      const result = JSON.parse(new TextDecoder().decode(api.planPdfFillAnnotation(message.source, JSON.stringify(message.request)))) as PdfFillAnnotationPlan;
      if (foreign) result.sourceIfcSha256 = '0'.repeat(64);
      queueMicrotask(() => worker.onmessage?.(new MessageEvent('message', { data: { type: 'pdf-fill-complete', id: message.id, result } })));
    } }; return worker;
  } });
  try {
    const options = { Name: 'Original page fills', toleranceMetres: 0.001, planner };
    const prepared = await preparePdfReferenceAnnotation('pdf-target', 40, fixture.reference.id, options);
    assert.equal(prepared.regions, 2);
    assert.deepEqual(prepared.meshes.map(mesh => mesh.color).sort(), [[0, 1, 0, 1], [1, 0, 0, 1]]);
    assert.ok(prepared.meshes.every(mesh => !mesh.textureRef && !mesh.textureBitmap && !mesh.uvs));
    assert.equal(fixture.view.getNewEntities().length, 0, 'a reviewable native preview publishes no IFC rows');
    assert.equal(useViewerStore.getState().models.get('pdf-target')?.geometryResult?.meshes.length, 0);
    assert.equal(useViewerStore.getState().undoStacks.get('pdf-target')?.length ?? 0, 0);
    useViewerStore.getState().updateAppearanceReference(fixture.reference.id, { opacity: 0.5 });
    // Reference edits advance the shared appearance revision, so either guard may refuse first.
    assert.throws(() => prepared.validate(), /changed/);
    assert.equal(fixture.view.getNewEntities().length, 0);
    prepared.dispose();
    foreign = true;
    await assert.rejects(preparePdfReferenceAnnotation('pdf-target', 40, fixture.reference.id, options), /frozen PDF and IFC/);
    assert.equal(fixture.view.getNewEntities().length, 0);
    foreign = false;
    const next = await preparePdfReferenceAnnotation('pdf-target', 40, fixture.reference.id, options);
    useViewerStore.setState({ models: new Map() });
    assert.throws(() => next.validate(), /target model changed/); next.dispose();
  } finally { planner.dispose(); fixture.dispose(); api.free(); }
});
