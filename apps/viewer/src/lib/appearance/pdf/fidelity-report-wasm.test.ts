/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { texturedProductSource as source } from '@/test/textured-product-fixture';
import { runPdfJob, type PdfEngineBackend } from './engine.js';
import { fidelityControlPdf } from './fixtures.js';
import type { PdfFillAnnotationPlan, PdfFillAnnotationRequest } from './fill-plan-types';
import type { PdfFidelityReport, PdfVectorPage, PreparedPdfVectorPage } from './vector-types';

type NativeApi = { preparePdfVectorPage(json: string): Uint8Array; planPdfFillAnnotation(source: Uint8Array, json: string): Uint8Array; free(): void };
async function nativeApi(t: TestContext): Promise<NativeApi | undefined> {
  let binary: Buffer;
  try { binary = await readFile(new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; t.skip('Build WASM with pnpm build:wasm'); return; }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm'); await init({ module_or_path: binary });
  return new IfcAPI();
}
/** The production adapter on the controlled page: one model metre per 30 PDF units, as in the committed evidence. */
async function decode(control: string): Promise<PdfVectorPage> {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const backend: PdfEngineBackend = { getDocument: pdf.getDocument, vectorDecoder: { version: pdf.version, ops: pdf.OPS },
    options: { disableFontFace: true, useSystemFonts: false }, surface() { throw new Error('Vector decoding must not create raster surfaces'); } };
  const result = await runPdfJob(backend, fidelityControlPdf(control), { kind: 'vectors', request: {
    pageNumber: 1, modelMetresFromPdf: [1 / 30, 0, 0, 1 / 30, 0, 0], calibrationKey: 'synthetic-control-30-pdf-units-per-metre', toleranceMetres: 0.0001 } });
  if (result.kind !== 'vectors') throw new Error('Wrong PDF job response');
  return result.page;
}
const report = (api: NativeApi, page: PdfVectorPage) => (JSON.parse(new TextDecoder().decode(api.preparePdfVectorPage(JSON.stringify(page)))) as PreparedPdfVectorPage).fidelity;
const summary = (verdict: PdfFidelityReport) => verdict.summary.map(entry => [entry.kind, entry.count, entry.visibleCount]);

test('controlled pages report each fidelity category with page extent and visibility through the real decoder (#4406)', async t => {
  const api = await nativeApi(t); if (!api) return;
  try {
    const transforms = report(api, await decode('transforms'));
    assert.deepEqual([transforms.exact, transforms.rasterOnly, transforms.convertiblePaths, transforms.summary], [true, false, 2, []], 'transforms and cubic fills are convertible content');
    const text = report(api, await decode('text'));
    assert.equal(text.exact, false);
    assert.deepEqual(summary(text), [['text', 1, 1]]);
    const box = text.summary[0]!.bboxPdf!;
    assert.equal(box[0], 10, 'text extent starts at its origin in PDF user space');
    assert.ok(Math.abs(box[1] - 16.4) < 1e-9 && Math.abs(box[3] - 32) < 1e-9 && box[2] > 30 && box[2] < 110, JSON.stringify(box));
    assert.equal(text.omissions.length, 1);
    const invisible = report(api, await decode('invisibleText'));
    assert.equal(invisible.exact, true, 'render-mode-3 text paints nothing, so it is not a visible loss');
    assert.deepEqual(summary(invisible), [['text', 1, 0]]);
    const clip = report(api, await decode('clip'));
    assert.deepEqual([clip.exact, clip.convertiblePaths, clip.omittedPaints], [false, 1, 1]);
    assert.deepEqual(summary(clip), [['clip', 1, 1]]);
    assert.deepEqual(clip.summary[0]!.bboxPdf, [0, 0, 80, 80], 'the clipped fill is located, the later unclipped fill converts');
    const transparency = report(api, await decode('transparency'));
    assert.deepEqual([transparency.exact, transparency.convertiblePaths], [false, 1]);
    assert.deepEqual(summary(transparency), [['transparency', 1, 1]]);
    const strokes = report(api, await decode('strokes'));
    assert.deepEqual([strokes.exact, strokes.convertiblePaths, strokes.omittedPaints], [false, 1, 2]);
    assert.deepEqual(summary(strokes), [['dash', 1, 1], ['roundCapJoin', 1, 1]]);
    assert.deepEqual(strokes.summary.map(entry => entry.bboxPdf), [[20, 50, 60, 50], [20, 30, 60, 30]]);
    const form = report(api, await decode('form'));
    assert.deepEqual([form.exact, form.convertiblePaths], [false, 1]);
    assert.deepEqual(summary(form), [['clip', 1, 1]], 'a form BBox that does not contain the page clips its content');
    assert.deepEqual(form.summary[0]!.bboxPdf, [5, 5, 25, 25], 'form Matrix and content transform place the omitted fill');
    const hidden = report(api, await decode('hiddenLayer'));
    assert.deepEqual([hidden.exact, hidden.convertiblePaths], [true, 1]);
    assert.deepEqual(summary(hidden), [['hidden', 1, 0]], 'optional content hidden by the document configuration is not visible loss');
    const raster = report(api, await decode('rasterOnly'));
    assert.deepEqual([raster.rasterOnly, raster.exact, raster.convertiblePaths], [true, false, 0]);
    assert.deepEqual(summary(raster), [['image', 1, 1]]);
    assert.deepEqual(raster.summary[0]!.bboxPdf, [10, 20, 110, 92]);
  } finally { api.free(); }
});

test('an accepted partial conversion plans, exports and reopens with its provenance; unaccepted and raster-only pages refuse (#4406)', async t => {
  const api = await nativeApi(t); if (!api) return;
  try {
    const page = await decode('text'), verdict = report(api, page);
    const data = await new IfcParser().parseColumnar(source.slice().buffer);
    const view = new MutablePropertyView(data.properties, 'fidelity'), editor = new StoreEditor(data, view);
    const request: PdfFillAnnotationRequest = { schema: 'IFC4', sourceRevision: 'controlled-fidelity', nextExpressId: view.peekNextExpressId(), containerId: 40,
      GlobalId: '0aaaaaaaaaaaaaaaaaaaaa', containmentGlobalId: '0bbbbbbbbbbbbbbbbbbbbb', propertySetGlobalId: '0cccccccccccccccccccc1', propertyRelationGlobalId: '0cccccccccccccccccccc2',
      Name: 'Partial text page', frame: { origin: [2, 3, 4], axisU: [1, 0, 0], axisV: [0, 0, 1], sizeMetres: [8, 8] }, page, acceptedFidelitySha256: null };
    const plan = (r: PdfFillAnnotationRequest) => JSON.parse(new TextDecoder().decode(api.planPdfFillAnnotation(source, JSON.stringify(r)))) as PdfFillAnnotationPlan;
    assert.throws(() => plan(request), /1 visible omissions.*explicit acceptance/);
    assert.throws(() => plan({ ...request, acceptedFidelitySha256: '0'.repeat(64) }), /does not match/);
    assert.equal(view.getNewEntities().length, 0);
    const result = plan({ ...request, acceptedFidelitySha256: verdict.sha256 });
    assert.deepEqual([result.fidelity.exact, result.fidelity.sha256, result.regions.length], [false, verdict.sha256, 2]);
    for (const row of result.plan.created) assert.equal(editor.addEntity(row.type, row.attributes).expressId, row.expressId);
    const exported = await new StepExporter(data, view).exportAsync({ schema: 'IFC4', applyMutations: true, includeGeometry: true });
    const content = typeof exported.content === 'string' ? exported.content : new TextDecoder().decode(exported.content);
    assert.match(content, /IFCANNOTATION\('0aaaaaaaaaaaaaaaaaaaaa',(\$|#\d+),'Partial text page','PDF vectors, page 1: partial conversion; omitted 1 text','IfcLite:PdfVectorFills'/);
    assert.match(content, /IFCPROPERTYSET\('0cccccccccccccccccccc1',(\$|#\d+),'IfcLite_PdfVectorConversion','PDF vector conversion provenance \(partial conversion; omitted 1 text\)'/);
    assert.match(content, /IFCPROPERTYSINGLEVALUE\('AcceptedPartialConversion',\$,IFCBOOLEAN\(\.T\.\),\$\)/);
    assert.match(content, /IFCPROPERTYSINGLEVALUE\('ExactConversion',\$,IFCBOOLEAN\(\.F\.\),\$\)/);
    assert.match(content, /IFCPROPERTYSINGLEVALUE\('Omissions',\$,IFCTEXT\('\[\{"kind":"text","count":1,"visible":1\}\]'\),\$\)/);
    assert.match(content, new RegExp(`IFCPROPERTYSINGLEVALUE\\('SourcePdfSha256',\\$,IFCIDENTIFIER\\('${page.pdfSha256}'\\),\\$\\)`));
    assert.match(content, new RegExp(`IFCPROPERTYSINGLEVALUE\\('FidelitySha256',\\$,IFCIDENTIFIER\\('${verdict.sha256}'\\),\\$\\)`));
    assert.match(content, /IFCPROPERTYSINGLEVALUE\('SourceCropBox',\$,IFCTEXT\('\[10\.0,20\.0,110\.0,92\.0\]'\),\$\)/);
    assert.match(content, /IFCPROPERTYSINGLEVALUE\('SourceRotation',\$,IFCINTEGER\(90\),\$\)/);
    assert.match(content, /IFCPROPERTYSINGLEVALUE\('SourceUserUnit',\$,IFCREAL\(2\.\),\$\)/);
    assert.match(content, /IFCPROPERTYSINGLEVALUE\('ToleranceMetres',\$,IFCREAL\((0\.0001|1\.E-4)\),\$\)/);
    assert.match(content, /IFCPROPERTYSINGLEVALUE\('DecoderVersion',\$,IFCLABEL\('PDF\.js 6\.3\.289'\),\$\)/);
    assert.match(content, /IFCRELDEFINESBYPROPERTIES\('0cccccccccccccccccccc2',(\$|#\d+),\$,\$,\(#\d+\),#\d+\)/);
    const reopened = await new IfcParser().parseColumnar(new TextEncoder().encode(content).buffer);
    assert.equal(reopened.entities.getTypeName(result.annotationId), 'IfcAnnotation');
    const provenance = reopened.getProperties(result.annotationId).find(set => set.name === 'IfcLite_PdfVectorConversion');
    assert.ok(provenance, 'the provenance property set reopens on the annotation through the ordinary parser');
    const property = (name: string) => provenance.properties.find(entry => entry.name === name)?.value;
    assert.equal(provenance.properties.length, 20);
    assert.equal(property('SourcePdfSha256'), page.pdfSha256);
    assert.equal(property('FidelitySha256'), verdict.sha256);
    assert.equal(property('Omissions'), '[{"kind":"text","count":1,"visible":1}]');
    assert.equal(property('AcceptedPartialConversion'), true);
    assert.equal(property('ExactConversion'), false);
    assert.equal(Number(property('ToleranceMetres')), 0.0001);
    const rasterPage = await decode('rasterOnly'), rasterVerdict = report(api, rasterPage);
    assert.throws(() => plan({ ...request, page: rasterPage, acceptedFidelitySha256: rasterVerdict.sha256 }), /raster reference/, 'acceptance never turns a scan into vectors');
  } finally { api.free(); }
});
