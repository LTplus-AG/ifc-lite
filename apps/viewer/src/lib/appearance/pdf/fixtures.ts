/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Original controlled PDF content, dedicated to CC0. No real-project/private data. */
export function controlledPdf(contents = '1 0 0 rg 10 20 30 30 re f\n0 1 0 rg 90 60 20 30 re f\n', resources = ''): Uint8Array<ArrayBuffer> {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 144 144] /CropBox [10 20 110 92] /Rotate 90 /UserUnit 2 /Resources << ${resources} >> /Contents 4 0 R >>`,
    `<< /Length ${contents.length} >>\nstream\n${contents}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 144] /Resources << >> /Contents 4 0 R >>',
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
