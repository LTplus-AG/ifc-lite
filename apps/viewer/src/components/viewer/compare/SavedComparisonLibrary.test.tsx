/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { DEFAULT_THEME } from '@ifc-lite/charts';
import { useViewerStore } from '@/store';
import { comparisonModels, comparisonResult } from '@/test/saved-comparison-fixture';
import { render, click, type, cleanup } from '@/test/render';
import { loadSavedComparisons, SAVED_COMPARISONS_KEY } from '@/lib/compare/savedComparisonPersistence';
import { SavedComparisonLibrary } from './SavedComparisonLibrary';
import { DocumentPanel } from '../document/DocumentPanel';
import { TABLE_ROWS_DEFAULT, DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';
import { parseDocumentFile } from '@/lib/document/persistence';
import type { DocumentPdfSeams } from '@/lib/document/generate-document-pdf';
import { Toaster } from '@/components/ui/toast';
import { latestToast } from '@/test/toasts';
import { stampAnalysisReport, captureAnalysisStamp } from '@/hooks/useAnalysisStaleness';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events.js';

function Library() { const result = useViewerStore((s) => s.compareResult); return <SavedComparisonLibrary result={result} running={false} />; }
const select = (el: HTMLSelectElement, value: string): void => { act(() => { el.value = value; el.dispatchEvent(new window.Event('change', { bubbles: true })); }); };
const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
afterEach(() => { cleanup(); localStorage.removeItem(SAVED_COMPARISONS_KEY); });

describe('Multiple saved pairs in mounted UI and documentation (#6506)', () => {
  it('blocks saving stale geometry and surfaces refused persistence while keeping the canonical report downloadable', () => {
    useViewerStore.setState({ models: comparisonModels(), savedComparisons: [], mutationVersion: 0, geometryContentVersion: 0 });
    const result = stampAnalysisReport(comparisonResult('A', 'B'), captureAnalysisStamp());
    act(() => useViewerStore.setState({ compareResult: result, geometryContentVersion: 1 }));
    const ui = render(<><Library /><Toaster /></>);
    const save = Array.from(ui.querySelectorAll('button')).find((b) => b.textContent === 'Save comparison');
    assert.ok(save); assert.ok(save.disabled, 'old bounds must not be projected into a new saved report');
    act(() => useViewerStore.setState({ compareResult: comparisonResult('A', 'B') }));
    const original = localStorage.setItem;
    Object.defineProperty(localStorage, 'setItem', { configurable: true, value: () => { throw new Error('quota'); } });
    try {
      click(save);
      assert.match(latestToast(ui), /storage is unavailable or full/);
      assert.ok(ui.querySelector('tbody')?.textContent?.includes('wall'));
      assert.equal(ui.querySelector('select')?.options.length, 2, 'unsaved report remains selectable in memory');
    } finally {
      Object.defineProperty(localStorage, 'setItem', { configurable: true, value: original });
    }
  });

  it('saves three real engine comparisons, reloads history, selects a document copy and prints its rows after library deletion/model unload', async () => {
    useViewerStore.setState({ models: comparisonModels(), savedComparisons: [], mutationVersion: 0, compareResult: comparisonResult('A', 'B') });
    let ui = render(<Library />);
    for (const [base, head] of [['A', 'B'], ['A', 'C'], ['B', 'C']]) {
      act(() => useViewerStore.setState({ compareResult: comparisonResult(base, head) }));
      const name = ui.querySelector<HTMLInputElement>('input[aria-label="Comparison name"]');
      assert.ok(name); type(name, `${base}/${head}`);
      const save = Array.from(ui.querySelectorAll('button')).find((b) => b.textContent === 'Save comparison');
      assert.ok(save); click(save);
    }
    const history = loadSavedComparisons();
    assert.equal(history.length, 3);
    assert.deepEqual(history.map((c) => c.report.rows.map((r) => r.globalId)), [['new', 'wall', 'removed'], ['new', 'third', 'wall', 'removed'], ['third', 'new']]);
    cleanup();
    act(() => {
      for (const id of useViewerStore.getState().models.keys()) useViewerStore.getState().removeModel(id);
    });
    assert.equal(useViewerStore.getState().models.size, 0);
    assert.equal(useViewerStore.getState().savedComparisons.length, 3, 'canonical model teardown preserves saved reports');
    act(() => { useViewerStore.getState().resetViewerState(); useViewerStore.getState().clearAllModels(); });
    assert.deepEqual(useViewerStore.getState().savedComparisons.map((saved) => saved.report.rows.map((row) => row.globalId)),
      [['new', 'wall', 'removed'], ['new', 'third', 'wall', 'removed'], ['third', 'new']],
      'session reset and full federation clear preserve historical report rows');
    act(() => useViewerStore.setState({ savedComparisons: history }));
    ui = render(<Library />);
    const picker = ui.querySelector('select'); assert.ok(picker); select(picker, history[2].id);
    assert.ok(ui.textContent?.includes('Base: B; Head: C'));
    assert.ok(ui.querySelector('tbody')?.textContent?.includes('third'));
    cleanup();

    const spec: DocumentSpec = { version: DOCUMENT_VERSION, id: 'saved-doc', name: 'Pair report', page: { size: 'A4', orientation: 'portrait' },
      blocks: [{ kind: 'table', id: 'table', maxRows: TABLE_ROWS_DEFAULT, source: { kind: 'comparison', comparison: structuredClone(history[0]) } }],
    };
    act(() => useViewerStore.setState({ documents: [spec], activeDocumentId: spec.id, activeModelId: null, dashboards: [], bcfProject: null,
      selectedEntityIds: new Set(), mutationViews: new Map() }));
    const printed: string[] = []; const tableCells: string[][] = [];
    const seams = async (): Promise<DocumentPdfSeams> => ({
      createDoc: async () => ({ addPage: () => {}, setFont: () => {}, setFontSize: () => {}, setTextColor: () => {},
        text: (text) => { printed.push(text); }, fillRect: () => {}, addImage: () => {}, svg: async () => {},
        table: (table) => { tableCells.push(...table.body); }, pageCount: () => 1, output: () => new Blob(['pdf']),
      }), renderSvg: () => '', capture: null, theme: DEFAULT_THEME, now: () => new Date(0), imageSize: async () => ({ w: 1, h: 1 }),
    });
    ui = render(<DocumentPanel pdfSeams={seams} />); await settle();
    const previewBlock = ui.querySelector('[data-preview-block="table"]'); assert.ok(previewBlock); click(previewBlock);
    await settle();
    const source = ui.querySelector<HTMLSelectElement>('select[aria-label="Choose saved comparison for document"]'); assert.ok(source);
    select(source, history[1].id); await settle();
    assert.ok(ui.querySelector('[data-block-table]')?.textContent?.includes('Base: A; Head: C'));
    const doc = useViewerStore.getState().documents[0];
    const imported = parseDocumentFile(JSON.stringify(doc));
    assert.equal(imported.blocks[0].kind, 'table');
    act(() => { useViewerStore.getState().deleteSavedComparison(history[1].id); });
    await settle();
    assert.ok(ui.querySelector('[data-block-table]')?.textContent?.includes('third'), 'embedded rows survive deleting the library entry');
    let downloaded = false; const onDownload = () => { downloaded = true; };
    window.addEventListener(EVENT_FILE_DOWNLOADED, onDownload);
    try {
      const button = ui.querySelector('[data-document-export]'); assert.ok(button); click(button);
      for (let i = 0; i < 20 && !downloaded; i++) await settle();
      assert.ok(downloaded);
    } finally { window.removeEventListener(EVENT_FILE_DOWNLOADED, onDownload); }
    assert.ok(printed.includes('Base: A; Head: C'));
    assert.deepEqual(tableCells.map((r) => r[0]), ['new', 'third', 'wall', 'removed']);
    assert.ok(printed.some((line) => line.includes('Products: Added 2; deleted 1; modified 1')));
  });
});
