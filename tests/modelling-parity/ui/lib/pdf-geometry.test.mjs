/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pdfPathExtents, sectionSpanMm } from './pdf-geometry.mjs';
const require = createRequire(new URL('../../../../apps/viewer/package.json', import.meta.url));
test('#9296 PDF line is measured in physical mm', async () => {
  const { jsPDF } = require('jspdf');
  const pdf = new jsPDF({ unit: 'mm' });
  pdf.line(10, 20, 110, 20);
  const extents = await pdfPathExtents(new Uint8Array(pdf.output('arraybuffer')));
  assert.ok(extents.some(p => Math.abs(p.widthMm-100) < .01), JSON.stringify(extents));
  assert.ok(!extents.some(p => Math.abs(p.widthMm-50) < .01));
});

test('#9296 section scale excludes the paper and measures the two outer wall faces', async () => {
  const { jsPDF } = require('jspdf');
  const pdf = new jsPDF({ unit: 'mm' });
  pdf.rect(0,0,210,297);
  pdf.rect(10,20,4,60); pdf.rect(110,20,4,60);
  const extents = await pdfPathExtents(new Uint8Array(pdf.output('arraybuffer')));
  assert.ok(Math.abs(sectionSpanMm(extents)-104) < .01);
});


test('#9874 section walls must share a PDF page', async () => {
  const { jsPDF } = require('jspdf');
  const pdf = new jsPDF({ unit: 'mm' });
  pdf.rect(10,20,4,60);
  pdf.addPage();
  pdf.rect(110,20,4,60);
  const extents = await pdfPathExtents(new Uint8Array(pdf.output('arraybuffer')));
  assert.deepEqual([...new Set(extents.map(p => p.page))],[1,2]);
  assert.ok(Number.isNaN(sectionSpanMm(extents)), 'one cut per page is not a two-wall section');
  pdf.addPage();
  pdf.rect(10,20,4,60); pdf.rect(110,20,4,60);
  const complete = await pdfPathExtents(new Uint8Array(pdf.output('arraybuffer')));
  assert.ok(Math.abs(sectionSpanMm(complete)-104) < .01, 'measure the complete section within its own page');
});
