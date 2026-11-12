import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pdfPathExtents } from './pdf-geometry.mjs';
const require = createRequire(new URL('../../../../apps/viewer/package.json', import.meta.url));
test('#9296 PDF line is measured in physical mm', async () => {
  const { jsPDF } = require('jspdf');
  const pdf = new jsPDF({ unit: 'mm' });
  pdf.line(10, 20, 110, 20);
  const extents = await pdfPathExtents(new Uint8Array(pdf.output('arraybuffer')));
  assert.ok(extents.some(p => Math.abs(p.widthMm-100) < .01), JSON.stringify(extents));
  assert.ok(!extents.some(p => Math.abs(p.widthMm-50) < .01));
});
