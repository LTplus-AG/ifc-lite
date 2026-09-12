/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { useViewerStore } from '@/store';
import { pdfReferenceAnnotationFixture } from '@/test/pdf-reference-annotation-fixture';
import { createAppearancePlanner, type AppearancePlanner, type AppearanceWorker } from '../planner-worker-client';
import type { AppearanceWorkerResponse } from '../planner-types';
import type { PdfFillAnnotationPlan } from './fill-plan-types';
import type { PreparedPdfVectorPage } from './vector-types';
import { checkPdfReferenceVectors } from './prepare-reference-annotation';

type NativeApi = { preparePdfVectorPage(json: string): Uint8Array; planPdfFillAnnotation(source: Uint8Array, json: string): Uint8Array; free(): void };
const HELVETICA = '/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>';
async function nativeApi(t: TestContext): Promise<NativeApi | undefined> {
  let binary: Buffer;
  try { binary = await readFile(new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; t.skip('Build WASM with pnpm build:wasm'); return; }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm'); await init({ module_or_path: binary });
  return new IfcAPI();
}
/** Real native fidelity and planning on the calling thread; `foreign` swaps the frozen IFC identity like a stale worker would. */
function directPlanner(api: NativeApi, flags: { foreign: boolean }): AppearancePlanner {
  return createAppearancePlanner({ workerFactory() {
    const worker: AppearanceWorker = { onmessage: null, onerror: null, onmessageerror: null, terminate() {}, postMessage(message) {
      const reply = (data: AppearanceWorkerResponse) => queueMicrotask(() => worker.onmessage?.(new MessageEvent('message', { data })));
      if (message.type === 'pdf-fidelity') {
        const result = JSON.parse(new TextDecoder().decode(api.preparePdfVectorPage(JSON.stringify(message.request)))) as PreparedPdfVectorPage;
        reply({ type: 'pdf-fidelity-complete', id: message.id, result }); return;
      }
      if (message.type !== 'pdf-fill-plan') throw new Error('Unexpected planner operation');
      const result = JSON.parse(new TextDecoder().decode(api.planPdfFillAnnotation(message.source, JSON.stringify(message.request)))) as PdfFillAnnotationPlan;
      if (flags.foreign) result.sourceIfcSha256 = '0'.repeat(64);
      reply({ type: 'pdf-fill-complete', id: message.id, result });
    } }; return worker;
  } });
}

test('original PDF and exact effective IFC bind the native multicolour preview before any authoring (#4406)', async t => {
  const api = await nativeApi(t); if (!api) return;
  const fixture = await pdfReferenceAnnotationFixture(), flags = { foreign: false }, planner = directPlanner(api, flags);
  try {
    const check = await checkPdfReferenceVectors(fixture.reference.id, { toleranceMetres: 0.001, planner });
    assert.deepEqual([check.report.exact, check.report.rasterOnly, check.report.convertiblePaths, check.report.summary], [true, false, 2, []]);
    assert.equal(check.prepared.toleranceMetres, 0.001, 'the declared tolerance is bound in metres after calibration');
    const prepared = await check.prepare('pdf-target', 40, { Name: 'Original page fills', acceptPartial: false });
    assert.equal(prepared.regions, 2);
    assert.equal(prepared.fidelity.sha256, check.report.sha256, 'the plan quotes the report it was checked against');
    assert.deepEqual(prepared.meshes.map(mesh => mesh.color).sort(), [[0, 1, 0, 1], [1, 0, 0, 1]]);
    assert.ok(prepared.meshes.every(mesh => !mesh.textureRef && !mesh.textureBitmap && !mesh.uvs));
    assert.equal(fixture.view.getNewEntities().length, 0, 'a reviewable native preview publishes no IFC rows');
    assert.equal(useViewerStore.getState().models.get('pdf-target')?.geometryResult?.meshes.length, 0);
    assert.equal(useViewerStore.getState().undoStacks.get('pdf-target')?.length ?? 0, 0);
    useViewerStore.getState().updateAppearanceReference(fixture.reference.id, { opacity: 0.5 });
    // Reference edits advance the shared appearance revision, so either guard may refuse first.
    assert.throws(() => check.validate(), /changed/);
    assert.throws(() => prepared.validate(), /changed/);
    assert.equal(fixture.view.getNewEntities().length, 0);
    check.dispose();
    flags.foreign = true;
    const again = await checkPdfReferenceVectors(fixture.reference.id, { toleranceMetres: 0.001, planner });
    await assert.rejects(again.prepare('pdf-target', 40, { Name: 'Original page fills', acceptPartial: false }), /frozen PDF, IFC and fidelity/);
    assert.equal(fixture.view.getNewEntities().length, 0);
    flags.foreign = false;
    const next = await again.prepare('pdf-target', 40, { Name: 'Original page fills', acceptPartial: false });
    useViewerStore.setState({ models: new Map() });
    assert.throws(() => next.validate(), /target model changed/);
    again.dispose();
  } finally { planner.dispose(); fixture.dispose(); api.free(); }
});

test('partial pages need explicit acceptance of the canonical report and raster-only pages never convert (#4406)', async t => {
  const api = await nativeApi(t); if (!api) return;
  const text = await pdfReferenceAnnotationFixture({ resources: HELVETICA,
    contents: 'BT /F1 12 Tf 10 20 Td (Visible text) Tj ET\n1 0 0 rg 20 30 30 30 re f\n0 1 0 rg 90 60 20 30 re f\n' });
  const planner = directPlanner(api, { foreign: false });
  try {
    const check = await checkPdfReferenceVectors(text.reference.id, { toleranceMetres: 0.001, planner });
    assert.deepEqual([check.report.exact, check.report.rasterOnly, check.report.convertiblePaths], [false, false, 2]);
    assert.deepEqual(check.report.summary.map(entry => [entry.kind, entry.count, entry.visibleCount]), [['text', 1, 1]]);
    assert.equal(check.report.summary[0]!.bboxPdf![0], 10, 'the omission carries its page-space extent');
    await assert.rejects(check.prepare('pdf-target', 40, { Name: 'Partial', acceptPartial: false }), /Accept the fidelity report/);
    assert.equal(text.view.getNewEntities().length, 0);
    const prepared = await check.prepare('pdf-target', 40, { Name: 'Partial', acceptPartial: true });
    assert.deepEqual([prepared.regions, prepared.fidelity.exact, prepared.fidelity.sha256], [2, false, check.report.sha256]);
    check.dispose();
  } finally { planner.dispose(); text.dispose(); }
  const raster = await pdfReferenceAnnotationFixture({ contents: 'q 100 0 0 72 10 20 cm BI /W 1 /H 1 /CS /G /BPC 8 /F /AHx ID 80> EI Q\n' });
  const second = directPlanner(api, { foreign: false });
  try {
    const check = await checkPdfReferenceVectors(raster.reference.id, { toleranceMetres: 0.001, planner: second });
    assert.deepEqual([check.report.rasterOnly, check.report.exact, check.report.convertiblePaths], [true, false, 0]);
    assert.deepEqual(check.report.summary.map(entry => [entry.kind, entry.visibleCount]), [['image', 1]]);
    await assert.rejects(check.prepare('pdf-target', 40, { Name: 'Raster', acceptPartial: true }), /raster reference/);
    assert.equal(raster.view.getNewEntities().length, 0);
    check.dispose();
  } finally { second.dispose(); raster.dispose(); api.free(); }
});
