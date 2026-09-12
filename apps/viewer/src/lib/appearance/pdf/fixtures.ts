/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** A stream object body for `controlledPdf` extra objects (form XObjects and the like). */
export function pdfStream(dictionary: string, body: string): string {
  return `<< ${dictionary} /Length ${body.length} >>\nstream\n${body}endstream`;
}
/** Original controlled PDF content, dedicated to CC0. No real-project/private data.
 * `extraObjects` are numbered from 6 and may be referenced from `resources` or `catalog`. */
export function controlledPdf(contents = '1 0 0 rg 10 20 30 30 re f\n0 1 0 rg 90 60 20 30 re f\n', resources = '',
  extraObjects: readonly string[] = [], catalog = ''): Uint8Array<ArrayBuffer> {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 144 144] /CropBox [10 20 110 92] /Rotate 90 /UserUnit 2 /Resources << ${resources} >> /Contents 4 0 R >>`,
    `<< /Length ${contents.length} >>\nstream\n${contents}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 144] /Resources << >> /Contents 4 0 R >>',
    ...extraObjects,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
const HELVETICA = '/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>';
/** Controlled fidelity pages (#4406), CC0. Each exercises one report category on the
 * same CropBox [10 20 110 92] / Rotate 90 / UserUnit 2 page so extents, visibility and
 * the exact/partial/raster-only verdicts are checked through the real decoder. */
export const fidelityControls: Readonly<Record<string, { contents: string; resources?: string; extraObjects?: readonly string[]; catalog?: string }>> = {
  transforms: { contents: 'q 2 0 0 3 4 5 cm 1 0 0 rg 5 5 m 20 5 l 20 20 l 5 20 l h f Q\n0 0 1 rg 30 30 m 40 30 45 40 30 40 c h f\n' },
  text: { contents: 'BT /F1 12 Tf 10 20 Td (Visible text) Tj ET\n1 0 0 rg 20 30 30 30 re f\n0 1 0 rg 90 60 20 30 re f\n', resources: HELVETICA },
  invisibleText: { contents: 'BT /F1 12 Tf 3 Tr 10 20 Td (hidden) Tj ET\n1 0 0 rg 20 30 30 30 re f\n', resources: HELVETICA },
  clip: { contents: 'q 0 0 40 40 re W n 1 0 0 rg 0 0 80 80 re f Q\n0 1 0 rg 90 60 20 30 re f\n' },
  transparency: { contents: 'q /GS1 gs 0 0 1 rg 20 30 10 10 re f Q\n1 0 0 rg 60 60 20 20 re f\n', resources: '/ExtGState << /GS1 << /ca 0.5 >> >>' },
  strokes: { contents: '0 0 1 RG 2 w 1 j 20 30 m 60 30 l S\n0 j [3 2] 0 d 20 50 m 60 50 l S\n[] 0 d 20 70 m 60 70 l S\n' },
  form: { contents: 'q /Fx1 Do Q\n1 0 0 rg 60 60 20 20 re f\n', resources: '/XObject << /Fx1 6 0 R >>',
    extraObjects: [pdfStream('/Type /XObject /Subtype /Form /BBox [0 0 50 50] /Matrix [2 0 0 2 5 5]', '0 0 1 rg 0 0 10 10 re f\n')] },
  hiddenLayer: { contents: '/OC /OC1 BDC 0 1 0 rg 20 30 10 10 re f EMC\n1 0 0 rg 20 30 30 30 re f\n', resources: '/Properties << /OC1 6 0 R >>',
    extraObjects: ['<< /Type /OCG /Name (Hidden) >>'], catalog: '/OCProperties << /OCGs [6 0 R] /D << /OFF [6 0 R] >> >>' },
  rasterOnly: { contents: 'q 100 0 0 72 10 20 cm BI /W 1 /H 1 /CS /G /BPC 8 /F /AHx ID 80> EI Q\n' },
};
export function fidelityControlPdf(name: string): Uint8Array<ArrayBuffer> {
  const control = fidelityControls[name];
  if (!control) throw new Error(`Unknown fidelity control ${name}`);
  return controlledPdf(control.contents, control.resources, control.extraObjects, control.catalog);
}
