/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { documentPreviewReady } from '@/test/document-preview';
import '@/test/content-fixture.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { DEFAULT_THEME } from '@ifc-lite/charts';
import { useViewerStore } from '@/store/index.js';
import { render, cleanup, type, click } from '@/test/render.js';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events.js';
import type { DocumentPdfSeams } from '@/lib/document/generate-document-pdf.js';
import { loadDocuments, parseDocumentFile } from '@/lib/document/persistence.js';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types.js';
import { DocumentPanel } from './DocumentPanel.js';

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
  await documentPreviewReady();
}

describe('Document text colours (#6492)', () => {
  afterEach(() => { cleanup(); localStorage.clear(); });

  for (const width of ['full', 'half'] as const) {
    it(`${width} text colours reach preview, PDF, browser storage and imported templates; reset clears both`, async () => {
      const spec: DocumentSpec = {
        version: DOCUMENT_VERSION, id: 'doc-6492', name: 'Colour report',
        page: { size: 'A4', orientation: 'portrait' },
        blocks: [
          { kind: 'text', id: 'colour', title: 'Coordination', style: 'caption', text: width === 'full' ? ['Authored ink', ...Array.from({ length: 199 }, (_, i) => `Line ${i}`)].join('\n') : 'Authored ink', width },
          { kind: 'text', id: 'default', style: 'body', text: 'Default ink', width },
        ],
      };
      useViewerStore.setState({
        models: new Map(), activeModelId: null, documents: [spec], activeDocumentId: spec.id,
        dashboards: [], bcfProject: null, selectedEntityIds: new Set(), mutationViews: new Map(), mutationVersion: 0,
      });
      const operations: Array<{ text?: string; ink?: number | string; svg?: string; rectColor?: string; width?: number }> = [];
      let ink: number | string = 0;
      const seams = async (): Promise<DocumentPdfSeams> => ({
        createDoc: async () => ({
          addPage: () => {}, setFont: () => {}, setFontSize: () => {},
          setTextColor: (color) => { ink = color; }, text: (text) => { operations.push({ text, ink }); },
          fillRect: (_x, _y, width, _height, rectColor) => { operations.push({ rectColor, width }); },
          addImage: () => {}, svg: async (svg, _x, _y, width) => { operations.push({ svg, width }); }, table: () => {},
          pageCount: () => 1, output: () => new Blob(['pdf']),
        }),
        renderSvg: () => '', capture: null, theme: DEFAULT_THEME, now: () => new Date(0), imageSize: async () => ({ w: 1, h: 1 }),
      });
      const ui = render(<DocumentPanel pdfSeams={seams} />);
      await settle();
      const editor = ui.querySelector('[data-block-editor="colour"]');
      assert.ok(editor);
      const textColor = editor.querySelector<HTMLInputElement>('input[aria-label="Text colour"]');
      const backgroundColor = editor.querySelector<HTMLInputElement>('input[aria-label="Background colour"]');
      assert.ok(textColor && backgroundColor);
      assert.equal(textColor.value, '#828282', 'caption defaults to its style ink');
      type(textColor, '#1264c8');
      type(backgroundColor, '#f1c35a');
      await settle();
      const preview = ui.querySelector<HTMLElement>('[data-preview-block="colour"] [data-block-text]');
      assert.ok(preview);
      assert.equal(window.getComputedStyle(preview).color, '#1264c8');
      assert.equal(preview.style.backgroundColor, '', '#6731: only composed body-line rectangles carry the fill; the title wrapper stays transparent');
      const fillsInPreview = Array.from(ui.querySelectorAll<HTMLElement>('[data-preview-block="colour"] [data-composed-fill="text-background"]'));
      assert.equal(fillsInPreview.length, width === 'full' ? 200 : 1);
      assert.ok(fillsInPreview.every(fill => fill.style.backgroundColor === '#f1c35a'));
      const heading = Array.from(preview.querySelectorAll('span')).find(span => span.textContent?.trim() === 'Coordination');
      assert.ok(heading);
      assert.ok(parseFloat(fillsInPreview[0].style.top) > parseFloat(heading.style.top), 'body fill starts below the title glyph');
      const saved = (await loadDocuments()).find((document) => document.id === spec.id);
      assert.ok(saved);
      const imported = parseDocumentFile(JSON.stringify(saved));
      assert.equal(imported.blocks[0].kind, 'text');
      if (imported.blocks[0].kind !== 'text') throw new Error('expected imported text');
      assert.equal(imported.blocks[0].textColor, '#1264c8');
      assert.equal(imported.blocks[0].backgroundColor, '#f1c35a');

      let downloaded = false;
      const onDownload = (): void => { downloaded = true; };
      window.addEventListener(EVENT_FILE_DOWNLOADED, onDownload);
      try {
        const exportButton = ui.querySelector('[data-document-export]');
        assert.ok(exportButton);
        click(exportButton);
        for (let i = 0; i < 20 && !downloaded; i++) await settle();
        assert.ok(downloaded);
      } finally { window.removeEventListener(EVENT_FILE_DOWNLOADED, onDownload); }
      assert.deepEqual(operations.find((operation) => operation.text === 'Authored ink'), { text: 'Authored ink', ink: '#1264c8' });
      assert.deepEqual(operations.find((operation) => operation.text === 'Default ink'), { text: 'Default ink', ink: 0 }, 'authored colour does not leak into a following block');
      const fills = operations.filter((operation) => operation.rectColor);
      assert.equal(fills.length, width === 'full' ? 200 : 1, 'all text lines get a direct vector rectangle');
      assert.equal(operations.filter((operation) => operation.svg).length, 0, 'text backgrounds never invoke SVG conversion');
      const fill = fills[0];
      assert.equal(fill?.rectColor, '#f1c35a', 'the background reaches the direct PDF vector renderer');
      assert.ok((fill?.width ?? 0) > (width === 'full' ? 400 : 200));
      if (width === 'half') assert.ok((fill?.width ?? 0) < 300, 'half background stops at the column edge');
      const fillIndex = operations.indexOf(fill!);
      assert.ok(fillIndex < operations.findIndex((operation) => operation.text === 'Authored ink'), 'background is painted before ink');

      const resetText = editor.querySelector('[aria-label="Reset text colour"]');
      const resetBackground = editor.querySelector('[aria-label="Clear background colour"]');
      assert.ok(resetText && resetBackground);
      click(resetText); click(resetBackground);
      await settle();
      const resetPreview = ui.querySelector<HTMLElement>('[data-preview-block="colour"] [data-block-text]');
      assert.ok(resetPreview, 'the recomposed current page remains visible after resetting colours');
      assert.equal(resetPreview.style.color, '');
      assert.equal(ui.querySelectorAll('[data-preview-block="colour"] [data-composed-fill="text-background"]').length, 0, '#6731: reset removes every painted body rectangle from the current preview');
      assert.equal(textColor.value, '#828282');
      const reset = (await loadDocuments()).find((document) => document.id === spec.id)?.blocks[0];
      assert.ok(reset?.kind === 'text');
      assert.equal(reset.textColor, undefined);
      assert.equal(reset.backgroundColor, undefined);
    });
  }
});
