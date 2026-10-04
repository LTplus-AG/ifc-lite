/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The mounted Document panel previews with the SAME captured labels its PDF
 * export prints with (#6741). `captured-numbers.pdf.test.tsx` proves preview
 * and PDF agree when a caller hands `labels` to `DocumentPreview`; this mounts
 * the real `DocumentPanel`, so it is the panel's own wiring under test: the
 * paper labels (page counter) and grouped counts (IDS summary) on screen must
 * be the strings the PDF producer receives from `data.labels`.
 */
import '@/test/setup-dom.js';
import { documentPreviewReady } from '@/test/document-preview';
import '@/test/content-fixture.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { DEFAULT_THEME, renderChartSvg } from '@ifc-lite/charts';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { useViewerStore } from '@/store/index.js';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import type { DocumentPdfSeams } from '@/lib/document/generate-document-pdf.js';
import { DOCUMENT_VERSION, type DocumentSpec, type IdsReportBlock } from '@/lib/document/types.js';
import { DocumentPanel } from './DocumentPanel.js';

// A frozen IDS snapshot: the block carries its own counts, so no model or validation run is needed.
const report: IdsReportBlock = { kind: 'ids-report', id: 'ids', variant: 'long', sourceName: 'Declared checks',
  generatedAt: '2026-10-02T12:00:00.000Z', benchmarks: false,
  summary: { checked: 22344, passed: 19999, failed: 2345, warnings: 0, passRate: 90 },
  checks: [{ id: 'one', shortDescription: 'Declared check', checked: 22344, passed: 19999, failed: 2345, passRate: 90, rules: [] }] };
const doc: DocumentSpec = { version: DOCUMENT_VERSION, id: 'doc-6741', name: 'Captured labels',
  page: { size: 'A4', orientation: 'portrait' }, blocks: [report] };

/** The PDF producer's drawn strings, recorded at the seam the panel exposes for tests. */
function recordingSeams(texts: string[]): () => Promise<DocumentPdfSeams> {
  return async () => ({
    createDoc: async () => ({
      addPage: () => {}, setFont: () => {}, setFontSize: () => {}, setTextColor: () => {}, fillRect: () => {},
      text: (t) => { texts.push(t); }, addImage: () => {}, svg: async () => {}, table: () => {},
      pageCount: () => 1, output: () => new Blob(['pdf']),
    }),
    renderSvg: (aggregation, w, h, theme) => renderChartSvg({ aggregation, width: w, height: h, theme, showTitle: false }),
    capture: null,
    theme: DEFAULT_THEME,
    now: () => new Date(0),
    imageSize: async () => ({ w: 2, h: 1 }),
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
  await documentPreviewReady();
}

async function exported(ui: HTMLElement, texts: string[]): Promise<string> {
  click(ui.querySelector<HTMLButtonElement>('[data-document-export]')!);
  await waitFor(() => texts.some((text) => text.includes('Declared checks')), 'the panel export reaches the PDF producer');
  await settle();
  return texts.join('\n');
}

const previewCounter = (ui: HTMLElement): string => ui.querySelector('[data-page-counter]')?.textContent ?? '';
const previewReport = (ui: HTMLElement): string => ui.querySelector('[data-preview-block="ids"]')?.textContent ?? '';

describe('DocumentPanel preview labels (#6741)', () => {
  beforeEach(() => {
    useViewerStore.setState({ models: new Map(), activeModelId: null, documents: [doc], activeDocumentId: doc.id,
      dashboards: [], bcfProject: null, selectedEntityIds: new Set() });
  });
  afterEach(() => { cleanup(); setLocale('en'); });

  it('previews captured paper labels and grouped counts exactly as the panel export prints them', async () => {
    registerLocale('de-6741', { 'document.print.pageCounter': 'Seite {page} / {total}', 'document.preview.idsReportChecked': 'Geprüft' });
    setLocale('de-6741');
    const texts: string[] = [];
    const ui = render(<DocumentPanel pdfSeams={recordingSeams(texts)} />);
    await settle();
    // The captured German context differs from the uncaptured English default ("Page 1 / 1", "22344").
    assert.equal(previewCounter(ui), 'Seite 1 / 1');
    assert.match(previewReport(ui), /Geprüft\s*22\.344/);
    assert.ok(!previewReport(ui).includes('22344') && !previewReport(ui).includes('22,344'));
    const printed = await exported(ui, texts);
    assert.ok(printed.includes('Seite 1 / 1'), 'the PDF prints the captured page counter');
    assert.ok(printed.includes('Geprüft 22.344'), 'the PDF prints the captured label with German grouping');
    assert.ok(!printed.includes('Page 1 / 1'));
  });

  it('remounts its preview on the capture the export holds, not a fresh one of its own', async () => {
    // Both captures are memoised on the locale revision, so their TEXT can only differ when the
    // catalogue's content changes without a revision. Mutating the registered catalogue in place
    // does exactly that, which makes "which capture is the preview using" observable: a preview
    // that captured for itself on remount shows "Blatt", the export's held capture still says "Seite".
    const catalogue: Catalogue = { 'document.print.pageCounter': 'Seite {page} / {total}' };
    registerLocale('de-6741-held', catalogue);
    setLocale('de-6741-held');
    const texts: string[] = [];
    const ui = render(<DocumentPanel pdfSeams={recordingSeams(texts)} />);
    await settle();
    assert.equal(previewCounter(ui), 'Seite 1 / 1');
    catalogue['document.print.pageCounter'] = 'Blatt {page} / {total}';
    // A stale active id renders the panel without a document for one pass; ensureActiveDocument
    // then reactivates it, so the preview unmounts and mounts again under the same panel.
    let unmounted = false;
    const seen = new MutationObserver((records) => {
      for (const { removedNodes } of records) for (const node of removedNodes) {
        if (node instanceof Element && (node.matches('[data-preview-block="ids"]') || node.querySelector('[data-preview-block="ids"]'))) unmounted = true;
      }
    });
    seen.observe(ui, { childList: true, subtree: true });
    act(() => useViewerStore.setState({ activeDocumentId: 'missing' }));
    await settle();
    seen.disconnect();
    assert.ok(unmounted, 'the preview unmounted under the stale id');
    assert.ok(ui.querySelector('[data-preview-block="ids"]'), 'the preview is mounted again');
    const printed = await exported(ui, texts);
    assert.ok(printed.includes('Seite 1 / 1'), 'the export prints with the labels captured for the panel');
    assert.equal(previewCounter(ui), 'Seite 1 / 1', 'the preview shows the labels the export printed with');
  });
});
