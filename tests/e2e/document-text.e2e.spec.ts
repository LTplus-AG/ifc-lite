/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test, expect } from '@playwright/test';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
interface DevServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  resolvedUrls: { local: string[] } | null;
}
let vite: DevServer;
let viewerUrl: string;

function mixedFontPdf(): number[] {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UTF16-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 5 >> /DW 1000 >>',
  ];
  const content = 'BT /F1 12 Tf 20 700 Td (Fire rating EI60) Tj /F2 12 Tf 0 -30 Td <65E5672C> Tj ET';
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  let source = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = source.length;
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Array.from(new TextEncoder().encode(source));
}

test.beforeAll(async () => {
  const requireFromViewer = createRequire(join(ROOT, 'apps/viewer/package.json'));
  const { createServer } = await import(pathToFileURL(requireFromViewer.resolve('vite')).href);
  vite = await createServer({ root: join(ROOT, 'apps/viewer'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  viewerUrl = vite.resolvedUrls?.local[0] ?? '';
  if (!viewerUrl) throw new Error('Vite did not expose its browser test URL');
});

test.afterAll(async () => { await vite.close(); });

test('#4177 production browser resources preserve mixed Latin and CMap text', async ({ page }) => {
  await page.goto(viewerUrl);
  const text = await page.evaluate(async ({ bytes, moduleUrl }) => {
    const documentText: typeof import('../../apps/viewer/src/lib/llm/document-text') = await import(moduleUrl);
    return documentText.extractPdfText(new Blob([new Uint8Array(bytes)]));
  }, { bytes: mixedFontPdf(), moduleUrl: '/src/lib/llm/document-text.ts' });
  expect(text).toContain('Fire rating EI60');
  expect(text).toContain('日本');
});
