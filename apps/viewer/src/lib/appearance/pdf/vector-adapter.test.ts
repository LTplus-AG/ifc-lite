/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPdfJob, type PdfEngineBackend } from './engine.js';
import { controlledPdf } from './fixtures.js';
import type { PdfVectorPage } from './vector-types.js';
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
test('actual painted text and clipping remain explicit blockers rather than omitted content (#4406)', async () => {
  const page = await decode(controlledPdf('BT /F1 12 Tf 10 20 Td (Visible text) Tj ET\nq 0 0 40 40 re W n 1 0 0 rg 0 0 80 80 re f Q\n', '/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>'));
  const blocked = page.operations.flatMap(x => x.operation.kind === 'unsupported' ? [x.operation.operator] : []);
  assert.ok(blocked.includes('showText'));
  assert.ok(blocked.includes('clip'));
  assert.ok(page.operations.some(x => x.operation.kind === 'path'));
});
