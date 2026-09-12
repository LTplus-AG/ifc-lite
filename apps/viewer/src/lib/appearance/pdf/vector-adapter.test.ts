/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPdfJob, type PdfEngineBackend } from './engine.js';
import { controlledPdf, pdfStream } from './fixtures.js';
import type { PdfVectorOperator, PdfVectorPage } from './vector-types.js';
async function decode(source: Uint8Array): Promise<PdfVectorPage> {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const backend: PdfEngineBackend = {
    getDocument: pdf.getDocument, vectorDecoder: { version: pdf.version, ops: pdf.OPS },
    options: { disableFontFace: true, useSystemFonts: false },
    surface() { throw new Error('Vector decoding must not create raster surfaces'); },
  };
  const copy = new Uint8Array(source);
  const result = await runPdfJob(backend, source, { kind: 'vectors', request: {
    pageNumber: 1, modelMetresFromPdf: [0,-0.002,0.002,0,-0.04,0.22],
    calibrationKey: 'measured-wall-v1', toleranceMetres: 0.0001,
  } });
  assert.deepEqual(source, copy, 'original owner bytes stay attached and unchanged');
  assert.equal(result.kind, 'vectors');
  if (result.kind !== 'vectors') throw new Error('Wrong PDF job response');
  return result.page;
}
function only<K extends PdfVectorOperator['kind']>(page: PdfVectorPage, kind: K): Array<Extract<PdfVectorOperator, { kind: K }>> {
  return page.operations.flatMap(({ operation }) => operation.kind === kind ? [operation as Extract<PdfVectorOperator, { kind: K }>] : []);
}
const HELVETICA = '/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>';
test('actual PDF vectors retain native CropBox/UserUnit/rotation and paint order (#4406)', async () => {
  const page = await decode(controlledPdf());
  assert.deepEqual(page.viewBox, [10,20,110,92]);
  assert.equal(page.userUnit, 2);
  assert.equal(page.intrinsicRotation, 90);
  assert.match(page.pdfSha256, /^[a-f0-9]{64}$/);
  const colors = page.operations.flatMap(({ operation }) => operation.kind === 'fillColor' ? [operation.rgb] : []);
  assert.deepEqual(colors, [[1,0,0],[0,1,0]]);
  const paths = page.operations.filter(({ operation }) => operation.kind === 'path');
  assert.equal(paths.length, 2);
  assert.ok(paths[0]!.ordinal < paths[1]!.ordinal);
  assert.ok(!page.operations.some(({ operation }) => operation.kind === 'unsupported'));
});
test('actual PDF dash, nonuniform transform, cubic commands and unused font setup survive (#4406)', async () => {
  // Source drawing invariant: the cubic and stroke are constructed BEFORE a
  // nonuniform affine is applied; preserving a scalar transformed width loses it.
  const page = await decode(controlledPdf('q 2 0 0 3 4 5 cm 2 w [4 2] 1 d 10 20 m 20 30 40 50 60 20 c S Q\n'));
  const ops = page.operations.map(x => x.operation);
  assert.ok(ops.some(x => x.kind === 'transform' && x.matrix.join(',') === '2,0,0,3,4,5'));
  assert.ok(ops.some(x => x.kind === 'dash' && x.lengths.join(',') === '4,2' && x.phase === 1));
  assert.ok(ops.some(x => x.kind === 'path' && x.commands.join(',') === '0,10,20,2,20,30,40,50,60,20'));
  assert.ok(!ops.some(x => x.kind === 'unsupported'), JSON.stringify(ops));
});
test('actual painted text, clipping, inline images and ExtGState decode as typed operations, never dropped (#4406)', async () => {
  const page = await decode(controlledPdf(
    'BT /F1 12 Tf 10 20 Td (Visible text) Tj 3 Tr (hidden) Tj ET\n'
    + 'q 0 0 40 40 re W n 1 0 0 rg 0 0 80 80 re f Q\n'
    + 'q /GS1 gs 0 0 1 rg 20 30 10 10 re f Q\n'
    + 'q 20 0 0 20 30 30 cm BI /W 1 /H 1 /CS /G /BPC 8 /F /AHx ID 80> EI Q\n',
    `${HELVETICA} /ExtGState << /GS1 << /ca 0.5 >> >>`));
  assert.deepEqual(only(page, 'unsupported'), [], 'every operator of this page is typed');
  const text = only(page, 'text');
  assert.equal(text.length, 2);
  assert.equal(text[0]!.invisible, false);
  assert.equal(text[1]!.invisible, true, 'render mode 3 text is decoded but marked invisible');
  // The run starts at the text origin and its em-box extent follows the 12 pt size and Helvetica advances.
  assert.equal(text[0]!.quad[0], 10);
  assert.ok(Math.abs(text[0]!.quad[1] - (20 - 0.3 * 12)) < 1e-9);
  assert.ok(text[0]!.quad[2] > 30 && text[0]!.quad[2] < 110, JSON.stringify(text[0]));
  assert.ok(Math.abs(text[0]!.quad[5] - (20 + 12)) < 1e-9);
  assert.ok(text[1]!.quad[0] > text[0]!.quad[2] - 1e-9, 'the second run continues after the first advance');
  assert.deepEqual(only(page, 'clip'), [{ kind: 'clip', evenOdd: false }]);
  const [gstate] = only(page, 'graphicsState');
  assert.deepEqual([gstate!.transparency, gstate!.unsupported, gstate!.lineWidth], [['ca'], [], null]);
  assert.deepEqual(only(page, 'image'), [{ kind: 'image', transforms: [[1, 0, 0, 1, 0, 0]] }]);
  assert.equal(only(page, 'path').length, 3, 'clip rectangle (endPath), clipped fill and transparent fill');
  assert.equal(only(page, 'textClip').length, 0);
});
test('actual form XObjects and optional content carry their matrix, bbox and visibility (#4406)', async () => {
  const form = pdfStream('/Type /XObject /Subtype /Form /BBox [0 0 50 50] /Matrix [2 0 0 2 5 5]', '0 0 1 rg 0 0 10 10 re f\n');
  const hiddenLayer = '<< /Type /OCG /Name (Hidden) >>';
  const page = await decode(controlledPdf(
    'q /Fx1 Do Q\n/OC /OC1 BDC 0 1 0 rg 20 30 10 10 re f EMC\n1 0 0 rg 60 60 20 20 re f\n',
    '/XObject << /Fx1 6 0 R >> /Properties << /OC1 7 0 R >>', [form, hiddenLayer],
    '/OCProperties << /OCGs [7 0 R] /D << /OFF [7 0 R] >> >>'));
  assert.deepEqual(only(page, 'unsupported'), []);
  assert.deepEqual(only(page, 'formBegin'), [{ kind: 'formBegin', matrix: [2, 0, 0, 2, 5, 5], bbox: [0, 0, 50, 50] }]);
  const kinds = page.operations.map(({ operation }) => operation.kind);
  assert.ok(kinds.indexOf('formBegin') < kinds.indexOf('path') && kinds.indexOf('path') < kinds.indexOf('formEnd'), kinds.join(','));
  assert.deepEqual(only(page, 'markedContent'), [{ kind: 'markedContent', visible: false }], 'the document configuration hides OC1');
  assert.equal(only(page, 'endMarkedContent').length, 1);
  assert.equal(only(page, 'path').length, 3);
});
